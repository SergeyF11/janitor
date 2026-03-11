#!/usr/bin/env node
/**
 * ESP эмулятор — новый протокол ($devices/{MAC}/commands, $devices/{MAC}/events)
 *
 * Первый запуск (регистрация):
 *   node esp-emulator.js 123456
 *
 * Повторный запуск (без кода):
 *   node esp-emulator.js
 *
 * npm install mqtt node-fetch
 */

'use strict'
const fs    = require('fs')
const mqtt  = require('mqtt')
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a))

const API_BASE   = process.env.API_BASE  || 'http://localhost:3000/janitor/api'
const MQTT_HOST  = process.env.MQTT_HOST || 'mqtt://localhost:1883'
const FW_VERSION = '0.1.0-emulator'
const CREDS_FILE = '.esp-creds.json'

const code = process.argv[2]
const mac  = (process.argv[3] || randomMac()).toUpperCase().replace(/[:\-]/g, '')
const macFormatted = mac.match(/.{2}/g).join(':')

// Реле эмулятора: index → {group, state}
// Заполняется из ответа регистрации
const relays = {}   // { 0: { group: 'test', state: 'off' }, ... }

// ── Регистрация ────────────────────────────────────────────────
async function register() {
  console.log(`[esp] MAC: ${macFormatted}`)
  console.log(`[esp] Регистрация с кодом ${code}...`)

  const RELAYS_DEF = [
    { index: 0, pin: 5,  name: 'Реле 0' },
    { index: 1, pin: 12, name: 'Реле 1' },
  ]

  const res = await fetch(`${API_BASE}/device/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mac: macFormatted,
      fw_version: FW_VERSION,
      code,
      relays: RELAYS_DEF,
    }),
  })

  const body = await res.json()
  if (!res.ok) {
    console.error(`[esp] Ошибка регистрации: ${JSON.stringify(body)}`)
    process.exit(1)
  }

  console.log(`[esp] ✅ Зарегистрирован`)
  console.log(`[esp]    mqtt_user:    ${body.mqtt_user}`)
  console.log(`[esp]    device_id:    ${body.device_id}`)
  console.log(`[esp]    topic_cmd:    ${body.topic_cmd}`)
  console.log(`[esp]    topic_events: ${body.topic_events}`)
  return body
}

// ── MQTT ───────────────────────────────────────────────────────
function connectMqtt(creds) {
  const { mqtt_user, mqtt_pass, device_id, topic_cmd, topic_events } = creds

  // Инициализировать реле из ответа регистрации
  if (creds.relays && creds.relays.length > 0) {
    for (const r of creds.relays) {
      relays[r.relay_index] = { group: r.group, state: 'off' }
    }
  } else if (Object.keys(relays).length === 0) {
    relays[0] = { group: 'unknown', state: 'off' }
  }

  const client = mqtt.connect(MQTT_HOST, {
    username:        mqtt_user,
    password:        mqtt_pass,
    clientId:        `esp_${device_id}`,
    clean:           true,
    reconnectPeriod: 3000,
    // LWT — offline при обрыве
    will: {
      topic:   topic_events,
      payload: JSON.stringify({ online: false, ts: Date.now() }),
      retain:  true,
      qos:     1,
    },
  })

  client.on('connect', () => {
    console.log(`[esp] ✅ MQTT подключён`)

    // Публикуем online + полный статус всех реле
    const payload = {
      online: true,
      fw:     FW_VERSION,
      ts:     Date.now(),
      relays: Object.entries(relays).map(([idx, r]) => ({
        group: r.group,
        state: r.state,
      })),
    }
    client.publish(topic_events, JSON.stringify(payload), { retain: true, qos: 1 })
    console.log(`[esp] → online: ${JSON.stringify(payload.relays)}`)

    // Подписываемся на команды
    client.subscribe(topic_cmd, { qos: 1 }, err => {
      if (err) console.error('[esp] subscribe error:', err.message)
      else console.log(`[esp] Слушаю ${topic_cmd}\n`)
    })
  })

  client.on('message', (topic, message) => {
    let cmd
    try { cmd = JSON.parse(message.toString()) } catch { return }
    console.log(`[esp] ← команда: ${JSON.stringify(cmd)}`)

    const { group, action, duration } = cmd
    if (!group || !action) return

    // Найти реле по имени группы
    const relayEntry = Object.entries(relays).find(([, r]) => r.group === group)
    if (!relayEntry) {
      console.log(`[esp] ⚠ Группа "${group}" не найдена в реле`)
      return
    }
    const [relayIdx, relay] = relayEntry

    if (action === 'pulse') {
      const ms = duration || 500
      console.log(`[esp] ⚡ Реле ${relayIdx} (${group}): импульс ${ms}мс`)
      relay.state = 'on'
      publishChange(client, topic_events, [{ group, state: 'on' }])
      setTimeout(() => {
        relay.state = 'off'
        publishChange(client, topic_events, [{ group, state: 'off' }])
        console.log(`[esp] ○ Реле ${relayIdx} (${group}): выключено`)
      }, ms)

    } else if (action === 'on') {
      console.log(`[esp] ● Реле ${relayIdx} (${group}): включено`)
      relay.state = 'on'
      publishChange(client, topic_events, [{ group, state: 'on' }])

    } else if (action === 'off') {
      console.log(`[esp] ○ Реле ${relayIdx} (${group}): выключено`)
      relay.state = 'off'
      publishChange(client, topic_events, [{ group, state: 'off' }])

    } else if (action === 'toggle') {
      const newState = relay.state === 'on' ? 'off' : 'on'
      console.log(`[esp] ↕ Реле ${relayIdx} (${group}): ${newState}`)
      relay.state = newState
      publishChange(client, topic_events, [{ group, state: newState }])

    } else {
      console.log(`[esp] ⚠ Неизвестное действие: ${action}`)
    }
  })

  client.on('error',     err => console.error('[esp] MQTT ошибка:', err.message))
  client.on('close',     ()  => console.log('[esp] MQTT отключён, переподключение...'))
  client.on('reconnect', ()  => console.log('[esp] MQTT переподключение...'))
}

// Публикуем только изменившиеся реле массивом
function publishChange(client, topic, changes) {
  const payload = changes.map(c => ({ ...c, ts: Date.now() }))
  client.publish(topic, JSON.stringify(payload), { retain: true, qos: 1 })
  console.log(`[esp] → изменение: ${JSON.stringify(payload)}`)
}

function randomMac() {
  return Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('').toUpperCase()
}

// ── Старт ──────────────────────────────────────────────────────
;(async () => {
  try {
    let creds
    if (code) {
      if (code.length !== 6) {
        console.error('Использование: node esp-emulator.js [6-значный_код]')
        process.exit(1)
      }
      creds = await register()
      fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2))
      console.log(`[esp] Креды сохранены в ${CREDS_FILE}`)
    } else {
      if (!fs.existsSync(CREDS_FILE)) {
        console.error('[esp] Нет сохранённых кредов. Укажи код привязки.')
        process.exit(1)
      }
      creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
      console.log(`[esp] Загружены креды из ${CREDS_FILE}`)
      console.log(`[esp] device_id:  ${creds.device_id}`)
      console.log(`[esp] topic_cmd:  ${creds.topic_cmd}`)
    }
    connectMqtt(creds)
  } catch (e) {
    console.error('[esp] Ошибка:', e.message)
    process.exit(1)
  }
})()
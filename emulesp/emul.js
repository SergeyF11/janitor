#!/usr/bin/env node
/**
 * ESP эмулятор для локальной разработки.
 *
 * Первый запуск (регистрация):
 *   node esp-emulator.js 123456
 *
 * Повторный запуск (без кода):
 *   node esp-emulator.js
 *
 * Установка зависимостей (один раз):
 *   npm install mqtt node-fetch
 */

'use strict'
const fs     = require('fs')
const mqtt   = require('mqtt')
const fetch  = (...a) => import('node-fetch').then(({default: f}) => f(...a))

const API_BASE   = process.env.API_BASE  || 'http://localhost:3000/janitor/api'
const MQTT_HOST  = process.env.MQTT_HOST || 'mqtt://localhost:1883'
const FW_VERSION = '0.0.1-emulator'
const CREDS_FILE = '.esp-creds.json'

const code = process.argv[2]
const mac  = ((process.argv[3] || randomMac()).toUpperCase().replace(/[:\-]/g, ''))
const macFormatted = mac.match(/.{2}/g).join(':')

const RELAYS = [
  { index: 0, pin: 5,  name: 'Реле 0' },
  { index: 1, pin: 12, name: 'Реле 1' },
]

const state = { 0: false, 1: false }

// ── Регистрация ────────────────────────────────────────────────
async function register() {
  console.log(`[esp] MAC: ${macFormatted}`)
  console.log(`[esp] Регистрация с кодом ${code}...`)
  const res = await fetch(`${API_BASE}/device/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mac: macFormatted, fw_version: FW_VERSION, code, relays: RELAYS }),
  })
  const body = await res.json()
  if (!res.ok) {
    console.error(`[esp] Ошибка регистрации: ${JSON.stringify(body)}`)
    process.exit(1)
  }
  console.log(`[esp] ✅ Зарегистрирован`)
  console.log(`[esp]    mqtt_user:  ${body.mqtt_user}`)
  console.log(`[esp]    mqtt_topic: ${body.mqtt_topic}`)
  return body
}

// ── MQTT ───────────────────────────────────────────────────────
async function connectMqtt(creds) {
  const { mqtt_user, mqtt_pass, mqtt_topic } = creds
  const macClean = mqtt_user.replace('esp_', '')

  const client = mqtt.connect(MQTT_HOST, {
    username: mqtt_user,
    password: mqtt_pass,
    clientId: mqtt_user,
    clean: true,
    reconnectPeriod: 3000,
    will: {
      topic:   `sys/devices/${macClean}/status`,
      payload: JSON.stringify({ online: false, mac: macFormatted }),
      retain:  true,
      qos:     1,
    },
  })

  client.on('connect', () => {
    console.log(`[esp] ✅ MQTT подключён`)
    client.publish(`sys/devices/${macClean}/status`,
      JSON.stringify({ online: true, mac: macFormatted, fw: FW_VERSION }),
      { retain: true, qos: 1 }
    )
    publishStatus(client, mqtt_topic)
    client.subscribe(`relay/${mqtt_topic}/cmd`, err => {
      if (err) console.error('[esp] subscribe error:', err.message)
      else console.log(`[esp] Слушаю relay/${mqtt_topic}/cmd\n`)
    })
  })

  client.on('message', (topic, message) => {
    let cmd
    try { cmd = JSON.parse(message.toString()) } catch { return }
    console.log(`[esp] ← команда:`, JSON.stringify(cmd))
    const { relay, action, duration } = cmd
    if (relay === undefined) return

    if (action === 'pulse') {
      const ms = duration || 500
      console.log(`[esp] ⚡ Реле ${relay}: импульс ${ms}мс`)
      state[relay] = true
      publishStatus(client, mqtt_topic)
      setTimeout(() => {
        state[relay] = false
        publishStatus(client, mqtt_topic)
        console.log(`[esp] ○ Реле ${relay}: выключено`)
      }, ms)
    } else if (action === 'on') {
      console.log(`[esp] ● Реле ${relay}: включено`)
      state[relay] = true
      publishStatus(client, mqtt_topic)
    } else if (action === 'off') {
      console.log(`[esp] ○ Реле ${relay}: выключено`)
      state[relay] = false
      publishStatus(client, mqtt_topic)
    }
  })

  client.on('error', err => console.error('[esp] MQTT ошибка:', err.message))
  client.on('close', () => console.log('[esp] MQTT отключён, переподключение...'))
}

function publishStatus(client, mqtt_topic) {
  const payload = JSON.stringify(
    Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v ? 'on' : 'off']))
  )
  client.publish(`relay/${mqtt_topic}/status`, payload, { retain: true })
  console.log(`[esp] → статус: ${payload}`)
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
        console.error('[esp] Нет сохранённых кредов. Укажи код привязки для регистрации.')
        process.exit(1)
      }
      creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
      console.log(`[esp] Загружены креды из ${CREDS_FILE}`)
      console.log(`[esp] mqtt_user:  ${creds.mqtt_user}`)
      console.log(`[esp] mqtt_topic: ${creds.mqtt_topic}`)
    }
    await connectMqtt(creds)
  } catch (e) {
    console.error('[esp] Ошибка:', e.message)
    process.exit(1)
  }
})()
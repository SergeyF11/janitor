'use strict'

const mqtt = require('mqtt')
const { getDb } = require('../db/connection')

let client

async function initMqtt() {
  return new Promise((resolve, reject) => {
    const url = process.env.MQTT_BROKER_URL || 'mqtt://janitor-mosquitto:1883'
    console.log(`[mqtt] Connecting to ${url}...`)

    client = mqtt.connect(url, {
      clientId: `janitor-backend-${Date.now()}`,
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASSWORD,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
      clean: true
    })

    client.on('connect', () => {
      console.log('[mqtt] Connected to broker')
      // Подписываемся на статусы устройств и системные сообщения
      client.subscribe('relay/+/status')
      client.subscribe('sys/devices/+/info')
      client.subscribe('sys/devices/+/lock')
      resolve()
    })

    client.on('error', (err) => {
      console.error('[mqtt] Error:', err.message)
      reject(err)
    })

    client.on('message', handleMessage)

    client.on('reconnect', () => {
      console.log('[mqtt] Reconnecting...')
    })
  })
}

async function handleMessage(topic, payload) {
  try {
    const data = JSON.parse(payload.toString())
    const db = getDb()

    // ── Статус реле ─────────────────────────────────────────────
    // relay/{groupId}/status → обновить состояние в БД
    const statusMatch = topic.match(/^relay\/(.+)\/status$/)
    if (statusMatch) {
      const mqttTopic = `relay/${statusMatch[1]}/status`
      const groupTopic = statusMatch[1]

      if (data.state === 'on') {
        await db`
          UPDATE groups SET relay_state = true, updated_at = NOW()
          WHERE mqtt_topic = ${groupTopic}
        `
      } else if (data.state === 'off') {
        await db`
          UPDATE groups SET relay_state = false, updated_at = NOW()
          WHERE mqtt_topic = ${groupTopic}
        `
      }

      // Уведомить WebSocket подписчиков (через глобальный эмиттер)
      emitStatus(groupTopic, data)
      return
    }

    // ── Информация об устройстве при подключении ────────────────
    // sys/devices/{deviceId}/info
    const infoMatch = topic.match(/^sys\/devices\/(.+)\/info$/)
    if (infoMatch) {
      const deviceId = infoMatch[1]
      await db`
        UPDATE devices
        SET fw_version = ${data.fw_version || null},
            last_seen = NOW()
        WHERE device_id = ${deviceId}
      `
      console.log(`[mqtt] Device ${deviceId} online, fw: ${data.fw_version}`)
      return
    }

  } catch (e) {
    console.error('[mqtt] Error handling message:', topic, e.message)
  }
}

// ── Опубликовать команду триггера ──────────────────────────────
async function publishTrigger(groupTopic, userId, durationMs) {
  if (!client?.connected) throw new Error('MQTT broker not connected')

  const topic = `relay/${groupTopic}/trigger`
  const payload = JSON.stringify({
    action: durationMs > 0 ? 'pulse' : 'toggle',
    duration: durationMs,
    user_id: userId,
    ts: Date.now()
  })

  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

// ── WebSocket эмиттер (простой in-process event bus) ──────────
const listeners = new Map()

function emitStatus(groupTopic, data) {
  const subs = listeners.get(groupTopic) || []
  subs.forEach(fn => fn(data))
}

function subscribeStatus(groupTopic, fn) {
  if (!listeners.has(groupTopic)) listeners.set(groupTopic, [])
  listeners.get(groupTopic).push(fn)
  return () => {
    const arr = listeners.get(groupTopic) || []
    listeners.set(groupTopic, arr.filter(f => f !== fn))
  }
}

function getMqttClient() { return client }

module.exports = { initMqtt, publishTrigger, subscribeStatus, getMqttClient }

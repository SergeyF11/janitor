'use strict'
const mqtt = require('mqtt')
const { getDb } = require('../db/connection')

let client = null

async function connect() {
  const host     = process.env.MQTT_HOST     || 'localhost'
  const port     = process.env.MQTT_PORT     || '1883'
  const user     = process.env.MQTT_USER     || 'mqttadmin'
  const password = process.env.MQTT_PASSWORD || ''
  const protocol = process.env.MQTT_PROTOCOL || 'mqtt'  // mqtt | mqtts | ws | wss

  const url = `${protocol}://${host}:${port}`

  client = mqtt.connect(url, {
    username:           user,
    password,
    clientId:           `janitor-backend-${Date.now()}`,
    clean:              true,
    reconnectPeriod:    5000,
    connectTimeout:     10000,
    rejectUnauthorized: process.env.MQTT_REJECT_UNAUTHORIZED !== 'false',
  })

  client.on('connect', () => {
    console.log(`[mqtt] Connected to ${url}`)

    // Подписаться на статусы устройств и heartbeat
    client.subscribe('sys/devices/+/heartbeat', { qos: 1 })
    client.subscribe('sys/devices/+/status',    { qos: 1 })
    client.subscribe('relay/+/status',          { qos: 1 })
  })

  client.on('message', async (topic, payload) => {
    try {
      await handleMessage(topic, payload.toString())
    } catch (err) {
      console.error('[mqtt] message handler error:', err.message)
    }
  })

  client.on('error', (err) => {
    console.error('[mqtt] error:', err.message)
  })

  client.on('disconnect', () => {
    console.log('[mqtt] Disconnected')
  })

  return client
}

async function handleMessage(topic, payload) {
  const db = getDb()

  // sys/devices/<MAC>/heartbeat
  const hbMatch = topic.match(/^sys\/devices\/([^/]+)\/heartbeat$/)
  if (hbMatch) {
    const deviceId = hbMatch[1]
    let fwVersion = null
    try {
      const data = JSON.parse(payload)
      fwVersion = data.fw_version || null
    } catch {}

    await db`
      UPDATE devices
      SET last_seen  = NOW(),
          fw_version = COALESCE(${fwVersion}, fw_version)
      WHERE device_id = ${deviceId}
    `
    // Уведомить WebSocket клиентов об обновлении статуса
    broadcastDeviceStatus(deviceId, true)
    return
  }

  // sys/devices/<MAC>/status — расширенный статус от ESP
  const statusMatch = topic.match(/^sys\/devices\/([^/]+)\/status$/)
  if (statusMatch) {
    const deviceId = hbMatch?.[1] || statusMatch[1]
    await db`UPDATE devices SET last_seen = NOW() WHERE device_id = ${deviceId}`
    broadcastDeviceStatus(deviceId, true)
    return
  }

  // relay/<topic>/status — подтверждение выполнения команды от ESP
  const relayMatch = topic.match(/^relay\/([^/]+)\/status$/)
  if (relayMatch) {
    const mqttTopic = relayMatch[1]
    try {
      const data = JSON.parse(payload)
      // Найти группу по mqtt_topic и оповестить WebSocket
      broadcastRelayStatus(mqttTopic, data)
    } catch {}
  }
}

// ── WebSocket broadcast (заполняется из ws.js) ────────────────
let _broadcastRelayStatus  = () => {}
let _broadcastDeviceStatus = () => {}

function broadcastRelayStatus(mqttTopic, data) {
  _broadcastRelayStatus(mqttTopic, data)
}

function broadcastDeviceStatus(deviceId, online) {
  _broadcastDeviceStatus(deviceId, online)
}

function setBroadcasters(relayFn, deviceFn) {
  _broadcastRelayStatus  = relayFn
  _broadcastDeviceStatus = deviceFn
}

function getClient() {
  return client
}

module.exports = { connect, getClient, setBroadcasters }
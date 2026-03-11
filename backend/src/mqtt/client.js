'use strict'
const mqtt = require('mqtt')
const { getDb } = require('../db/connection')
const dynsec = require('./dynsec')

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

  dynsec.setClient(client)

  let backendRoleReady = false

  client.on('connect', async () => {
    console.log(`[mqtt] Connected to ${url}`)

    // Подписаться на события всех устройств
    client.subscribe('$devices/+/events', { qos: 1 })

    // Убедиться что у бэкенда есть права — только один раз, в фоне
    if (!backendRoleReady) {
      backendRoleReady = true  // сразу ставим флаг чтобы не запускать повторно
      dynsec.ensureBackendRole(user).catch(e => {
        backendRoleReady = false  // сбросить если не удалось
        console.error('[dynsec] ensureBackendRole:', e.message)
      })
    }
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

  // $devices/<MAC>/events — все события от ESP
  const eventsMatch = topic.match(/^\$devices\/([^/]+)\/events$/)
  if (!eventsMatch) return

  const macClean = eventsMatch[1]
  let data
  try { data = JSON.parse(payload) } catch { return }

  // LWT или явный offline: {online: false}
  if (data.online === false) {
    await db`
      UPDATE devices SET is_online = false WHERE device_id = ${macClean}
    `
    broadcastDeviceStatus(macClean, false)
    return
  }

  // Online + полный статус при подключении: {online: true, relays: [{group, state}, ...]}
  if (data.online === true) {
    await db`
      UPDATE devices
      SET is_online  = true,
          last_seen  = NOW(),
          fw_version = COALESCE(${data.fw || null}, fw_version)
      WHERE device_id = ${macClean}
    `
    broadcastDeviceStatus(macClean, true)

    // Разослать статус каждой группы
    if (Array.isArray(data.relays)) {
      for (const r of data.relays) {
        broadcastRelayStatus(r.group, r.state)
      }
    }
    return
  }

  // Изменение состояния реле: [{group, state, ts}, ...]
  if (Array.isArray(data)) {
    await db`UPDATE devices SET last_seen = NOW() WHERE device_id = ${macClean}`
    for (const r of data) {
      broadcastRelayStatus(r.group, r.state)
    }
    return
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
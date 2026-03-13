'use strict'
const mqtt   = require('mqtt')
const fs     = require('fs')
const { getDb } = require('../db/connection')

let client = null

async function connect() {
  const host     = process.env.MQTT_HOST || 'mqtt.cloud.yandex.net'
  const port     = parseInt(process.env.MQTT_PORT || '8883')
  const url      = `mqtts://${host}:${port}`

  const opts = {
    clientId:        `janitor-backend-${Date.now()}`,
    username:        '', // YC: auth via X.509
    clean:           true,
    reconnectPeriod: 5000,
    connectTimeout:  10000,
  }

  const certFile = process.env.MQTT_CERT_FILE
  const keyFile  = process.env.MQTT_KEY_FILE
  const caFile   = process.env.MQTT_CA_FILE

  if (certFile && keyFile) {
    opts.cert = fs.readFileSync(certFile)
    opts.key  = fs.readFileSync(keyFile)
    if (caFile) opts.ca = fs.readFileSync(caFile)
    opts.rejectUnauthorized = true
  } else {
    opts.rejectUnauthorized = false
  }

  client = mqtt.connect(url, opts)

  client.on('connect', () => {
    console.log(`[mqtt] Connected to ${url}`)
    const registryId = process.env.YC_REGISTRY_ID
    const topic = `$registries/${registryId}/events`
    client.subscribe(topic, { qos: 1 }, (err, granted) => {
      console.log(`[mqtt] Subscribe to ${topic}: err=${err}, granted=${JSON.stringify(granted)}`)
    })
  })

  client.on('message', async (topic, payload) => {
    console.log(`[mqtt] RAW message: ${topic} ${payload.toString()}`)
    try {
      await handleMessage(topic, payload.toString())
    } catch (err) {
      console.error('[mqtt] message handler error:', err.message)
    }
  })

  client.on('error',      (err) => console.error('[mqtt] error:', err.message))
  client.on('disconnect', ()    => console.log('[mqtt] Disconnected'))

  return client
}

async function handleMessage(topic, payload) {
  const db = getDb()

  const eventsMatch = topic.match(/^\$registries\/([^/]+)\/events/)
  if (!eventsMatch) return

  let data
  try { data = JSON.parse(payload) } catch { return }

  // Получить device_id из поля device в payload (YC device ID = mqtt_user)
  const ycDeviceId = data.device
  if (!ycDeviceId) return

  const [dev] = await db`SELECT device_id FROM devices WHERE mqtt_user = ${ycDeviceId}`
  if (!dev) return
  const deviceId = dev.device_id

  // LWT или явный offline
  if (data.online === false) {
    await db`UPDATE devices SET is_online = false WHERE device_id = ${deviceId}`
    broadcastDeviceStatus(deviceId, false)
    return
  }

  // Online
  if (data.online === true) {
    await db`
      UPDATE devices
      SET is_online  = true,
          last_seen  = NOW(),
          fw_version = COALESCE(${data.fw || null}, fw_version)
      WHERE device_id = ${deviceId}
    `
    broadcastDeviceStatus(deviceId, true)

    // Обновить last_state реле
    if (Array.isArray(data.relays)) {
      for (const r of data.relays) {
        await db`
          UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
          WHERE device_id = ${deviceId} AND name = ${r.name}
        `
        // Найти relay_id для WS broadcast
        const [relay] = await db`SELECT id FROM relays WHERE device_id = ${deviceId} AND name = ${r.name}`
        if (relay) broadcastRelayStatus(relay.id, r.state)
      }
    }
    return
  }

  // Изменение состояния реле: [{name, state, ts}, ...]
  if (Array.isArray(data)) {
    await db`UPDATE devices SET last_seen = NOW() WHERE device_id = ${deviceId}`
    for (const r of data) {
      await db`
        UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
        WHERE device_id = ${deviceId} AND name = ${r.name}
      `
      const [relay] = await db`SELECT id FROM relays WHERE device_id = ${deviceId} AND name = ${r.name}`
      if (relay) broadcastRelayStatus(relay.id, r.state)
    }
    return
  }
}

// ── WebSocket broadcast ───────────────────────────────────────
let _broadcastRelayStatus  = () => {}
let _broadcastDeviceStatus = () => {}

function broadcastRelayStatus(relayId, state) { _broadcastRelayStatus(relayId, state) }
function broadcastDeviceStatus(deviceId, online) { _broadcastDeviceStatus(deviceId, online) }

function setBroadcasters(relayFn, deviceFn) {
  _broadcastRelayStatus  = relayFn
  _broadcastDeviceStatus = deviceFn
}

function getClient() { return client }

module.exports = { connect, getClient, setBroadcasters }
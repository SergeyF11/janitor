'use strict'
const fs   = require('fs')
const mqtt = require('mqtt')
const { getDb } = require('../db/connection')

let client = null

async function connect() {
  const host     = process.env.MQTT_HOST     || 'mqtt.cloud.yandex.net'
  const port     = parseInt(process.env.MQTT_PORT || '8883')
  const certFile = process.env.MQTT_CERT_FILE
  const keyFile  = process.env.MQTT_KEY_FILE
  const caFile   = process.env.MQTT_CA_FILE

  const options = {
    clientId:           `janitor-backend-${Date.now()}`,
    clean:              true,
    reconnectPeriod:    5000,
    connectTimeout:     10000,
    cert:               fs.readFileSync(certFile),
    key:                fs.readFileSync(keyFile),
    ca:                 fs.readFileSync(caFile),
    rejectUnauthorized: true,
  }

  const url = `mqtts://${host}:${port}`
  client = mqtt.connect(url, options)

  client.on('connect', () => {
    console.log(`[mqtt] Connected to ${url}`)
    const registryId = process.env.YC_REGISTRY_ID
    client.subscribe(`$registries/${registryId}/events`, { qos: 1 })
  })

  client.on('message', async (topic, payload) => {
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

  const eventsMatch = topic.match(/^\$devices\/([^/]+)\/events$/)
  if (!eventsMatch) return

  const deviceId = eventsMatch[1]
  let data
  try { data = JSON.parse(payload) } catch { return }

  // ── offline: {online: false} или LWT ──
  if (data.online === false) {
    await db`UPDATE devices SET is_online = false WHERE device_id = ${deviceId}`
    broadcastDeviceStatus(deviceId, false)
    return
  }

  // ── online: {online: true, fw, relays: [{name, state}]} ──
  if (data.online === true) {
    await db`
      UPDATE devices
      SET is_online  = true,
          last_seen  = NOW(),
          fw_version = COALESCE(${data.fw || null}, fw_version)
      WHERE device_id = ${deviceId}
    `
    broadcastDeviceStatus(deviceId, true)

    if (Array.isArray(data.relays)) {
      for (const r of data.relays) {
        // Обновить last_state в relays по имени
        const [relay] = await db`
          UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
          WHERE device_id = ${deviceId} AND name = ${r.name}
          RETURNING id
        `
        if (relay) broadcastRelayStatus(relay.id, r.state)
      }
    }
    return
  }

  // ── изменение реле: [{name, state, ts}, ...] ──
  if (Array.isArray(data)) {
    await db`UPDATE devices SET last_seen = NOW() WHERE device_id = ${deviceId}`
    for (const r of data) {
      const [relay] = await db`
        UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
        WHERE device_id = ${deviceId} AND name = ${r.name}
        RETURNING id
      `
      if (relay) broadcastRelayStatus(relay.id, r.state)
    }
  }
}

let _broadcastRelayStatus  = () => {}
let _broadcastDeviceStatus = () => {}

function broadcastRelayStatus(relayId, state)   { _broadcastRelayStatus(relayId, state) }
function broadcastDeviceStatus(deviceId, online) { _broadcastDeviceStatus(deviceId, online) }
function setBroadcasters(relayFn, deviceFn) {
  _broadcastRelayStatus  = relayFn
  _broadcastDeviceStatus = deviceFn
}
function getClient() { return client }

module.exports = { connect, getClient, setBroadcasters }

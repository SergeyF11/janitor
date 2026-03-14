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
    if (!registryId) {
      console.error('[mqtt] YC_REGISTRY_ID is empty, skip subscribe')
      return
    }

    const topic = `$registries/${registryId}/events`
    client.subscribe(topic, { qos: 1 }, (err, granted) => {
      if (err) {
        console.error('[mqtt] subscribe error:', err.message)
        return
      }
      console.log('[mqtt] subscribed:', granted?.map((g) => `${g.topic} qos=${g.qos}`).join(', ') || topic)
    })
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
  let data
  try { data = JSON.parse(payload) } catch { return }

  // Формат Janitor/YC: $registries/{registryId}/events, device_id в payload.device
  const registryTopicMatch = topic.match(/^\$registries\/([^/]+)\/events$/)
  if (!registryTopicMatch) return

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.warn('[mqtt] skip registry event without object payload')
    return
  }

  const deviceId = data.device
  if (!deviceId) {
    console.warn('[mqtt] skip registry event without payload.device')
    return
  }

  return processDeviceEvent(db, deviceId, data)
}

async function processDeviceEvent(db, deviceId, data) {
  if (!data) return

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

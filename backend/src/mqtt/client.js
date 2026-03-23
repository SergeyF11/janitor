'use strict'
const mqtt     = require('mqtt')
const { getDb } = require('../db/connection')
const provider  = require('./provider')

let client = null

async function connect() {
  const { url, options } = provider.getConnectOptions()

  client = mqtt.connect(url, options)

  client.on('connect', () => {
    console.log(`[mqtt] Connected to ${url}`)
    const topics = provider.topicsToSubscribe()
    client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) console.error('[mqtt] subscribe error:', err.message)
      else console.log('[mqtt] Subscribed:', topics)
    })
  })

  client.on('message', async (topic, payload) => {
    try { await handleMessage(topic, payload.toString()) }
    catch (err) { console.error('[mqtt] handler error:', err.message) }
  })

  client.on('error',      err => console.error('[mqtt] error:', err.message))
  client.on('disconnect', ()  => console.log('[mqtt] Disconnected'))

  // Heartbeat fallback — только для Яндекса (LWT не работает)
  if (!provider.supportsLWT) {
    const TIMEOUT = provider.HEARTBEAT_TIMEOUT_MS || 3 * 60 * 60 * 1000
    setInterval(() => checkHeartbeatTimeouts(TIMEOUT), 60 * 60 * 1000)
    console.log(`[mqtt] Heartbeat timeout checker started (${TIMEOUT / 1000}s)`)
  }

  return client
}

async function handleMessage(topic, payload) {
  const db = getDb()
  console.log(`[mqtt] message: ${topic} ${payload}`)

  const parsed = await provider.parseMessage(topic, payload, db)
  if (!parsed) return

  const { deviceId, online, fw, relays } = parsed

  // Обновить is_online / last_seen
  if (online === true) {
    await db`
      UPDATE devices
      SET is_online  = true,
          last_seen  = NOW(),
          fw_version = COALESCE(${fw}, fw_version)
      WHERE device_id = ${deviceId}
    `
    broadcastDeviceStatus(deviceId, true)
  } else if (online === false) {
    await db`UPDATE devices SET is_online = false WHERE device_id = ${deviceId}`
    broadcastDeviceStatus(deviceId, false)
  } else if (fw) {
    // heartbeat без явного online поля
    await db`
      UPDATE devices
      SET last_seen  = NOW(),
          fw_version = COALESCE(${fw}, fw_version)
      WHERE device_id = ${deviceId}
    `
    broadcastDeviceStatus(deviceId, true)
  }

  // Обновить состояние реле
  if (relays && Array.isArray(relays)) {
    if (online == null) {
      await db`UPDATE devices SET last_seen = NOW() WHERE device_id = ${deviceId}`
    }
    for (const r of relays) {
      // Поддерживаем оба формата: {name, state} и {index, state}
      if (r.name) {
        const [relay] = await db`
          UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
          WHERE device_id = ${deviceId} AND name = ${r.name}
          RETURNING id
        `
        if (relay) broadcastRelayStatus(relay.id, r.state)
      } else if (r.index != null) {
        const [relay] = await db`
          UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
          WHERE device_id = ${deviceId} AND relay_index = ${r.index}
          RETURNING id
        `
        if (relay) broadcastRelayStatus(relay.id, r.state)
      }
    }
  }
}

// Heartbeat timeout — помечает устройства оффлайн если нет сигнала
async function checkHeartbeatTimeouts(timeoutMs) {
  const db = getDb()
  try {
    const stale = await db`
      UPDATE devices
      SET is_online = false
      WHERE is_online = true
        AND last_seen < NOW() - (${timeoutMs} || ' milliseconds')::interval
      RETURNING device_id
    `
    for (const d of stale) {
      console.log(`[mqtt] heartbeat timeout: ${d.device_id} -> offline`)
      broadcastDeviceStatus(d.device_id, false)
    }
  } catch (err) {
    console.error('[mqtt] heartbeat check error:', err.message)
  }
}

let _broadcastRelayStatus  = () => {}
let _broadcastDeviceStatus = () => {}

function broadcastRelayStatus(id, state)       { _broadcastRelayStatus(id, state) }
function broadcastDeviceStatus(deviceId, online) { _broadcastDeviceStatus(deviceId, online) }
function setBroadcasters(relayFn, deviceFn) {
  _broadcastRelayStatus  = relayFn
  _broadcastDeviceStatus = deviceFn
}
function getClient() { return client }

module.exports = { connect, getClient, setBroadcasters }
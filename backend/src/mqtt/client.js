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
    clean:              false,
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
      // Подписываемся на события ВСЕХ устройств реестра
    //const topic = '$devices/+/events/#' 
    const topics = [
    `$registries/${process.env.YC_REGISTRY_ID}/events`,
    `$devices/+/events/#`,
    `$devices/+/state`
  ]

    client.subscribe(topics, { qos: 1 }, (err, granted) => {
      console.log(`[mqtt] Subscribed to ${topics}`)
    })

    //const registryId = process.env.YC_REGISTRY_ID
    //const topic = `$registries/${registryId}/events`
    // client.subscribe(topic, { qos: 1 }, (err, granted) => {
    //   console.log(`[mqtt] Subscribe to ${topic}: err=${err}, granted=${JSON.stringify(granted)}`)
    // })
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

// async function handleMessage(topic, payload) {
//   console.log(`[mqtt] handleMessage entered: topic=${topic}, payload=${payload}`);
  
//   const db = getDb()
//   const eventsMatch = topic.match(/^\$registries\/([^/]+)\/events/)
//   if (!eventsMatch) return
//   let data
//   try { data = JSON.parse(payload) } catch { return }
//   const ycDeviceId = data.device
//   if (!ycDeviceId) return
//   const [dev] = await db`SELECT device_id FROM devices WHERE mqtt_user = ${ycDeviceId}`
//   if (!dev) return
//   const deviceId = dev.device_id
//   console.log(`[mqtt] message from device ${deviceId}:`, data)

//   try { data = JSON.parse(payload) } catch { return }

//   // ── offline: {online: false} или LWT ──
//   if (data.online === false) {
//     await db`UPDATE devices SET is_online = false WHERE device_id = ${deviceId}`
//     broadcastDeviceStatus(deviceId, false)
//     return
//   }

//   // ── online: {online: true, fw, relays: [{name, state}]} ──
//   if (data.online === true) {
//     await db`
//       UPDATE devices
//       SET is_online  = true,
//           last_seen  = NOW(),
//           fw_version = COALESCE(${data.fw || null}, fw_version)
//       WHERE device_id = ${deviceId}
//     `
//     broadcastDeviceStatus(deviceId, true)

//     if (Array.isArray(data.relays)) {
//       for (const r of data.relays) {
//         // Обновить last_state в relays по имени
//         const [relay] = await db`
//           UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
//           WHERE device_id = ${deviceId} AND name = ${r.name}
//           RETURNING id
//         `
//         if (relay) {
//           console.log(`[mqtt] updated relay ${relay.id} (name=${r.name}) to state ${r.state}`)
//           broadcastRelayStatus(relay.id, r.state)
//         } else {
//           console.log(`[mqtt] relay not found for device ${deviceId} with name ${r.name}`)
//         }
//       }
//     }
//     return
//   }

//   // ── изменение реле: [{name, state, ts}, ...] ──
//   if (Array.isArray(data)) {
//     await db`UPDATE devices SET last_seen = NOW() WHERE device_id = ${deviceId}`
//     for (const r of data) {
//       const [relay] = await db`
//         UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
//         WHERE device_id = ${deviceId} AND name = ${r.name}
//         RETURNING id
//       `
//       if (relay) {
//         console.log(`[mqtt] updated relay ${relay.id} (name=${r.name}) to state ${r.state}`)
//         broadcastRelayStatus(relay.id, r.state)
//       } else {
//         console.log(`[mqtt] relay not found for device ${deviceId} with name ${r.name}`)
//       }
//     }
//   }
// }

async function handleMessage(topic, payload) {
  const db = getDb()
  console.log(`[mqtt] handleMessage: topic=${topic}, payload=${payload}`)

  let data
  try {
    data = JSON.parse(payload)
  } catch (e) {
    console.error('[mqtt] JSON parse error:', e.message)
    return
  }

   // Универсальное извлечение ID устройства
  let ycDeviceId = data.device // 1. Пытаемся взять из JSON
  
  if (!ycDeviceId) {
    // 2. Если в JSON нет (как в вашем LWT), вытаскиваем из топика
    const parts = topic.split('/')
    if (topic.startsWith('$devices/')) {
      ycDeviceId = parts[1] // Из $devices/ID/events...
    } else if (topic.startsWith('$registries/')) {
      // Если это системное событие реестра, ID устройства может быть внутри JSON
      // но если мы шлем LWT в реестр вручную, ID должен быть в payload.
      // Если вы шлете в $registries/REG_ID/events/DEVICE_ID — тогда parts[3]
      ycDeviceId = data.device 
    }
  }

  if (!ycDeviceId) {
    console.log(`[mqtt] skip message: cannot determine device ID from topic ${topic} or payload`)
    return
  }
  
    const [dev] = await db`SELECT device_id FROM devices WHERE mqtt_user = ${ycDeviceId}`
    if (!dev) {
      console.log(`[mqtt] device not found for mqtt_user=${ycDeviceId}`)
      return
    }
    const deviceId = dev.device_id
    console.log(`[mqtt] message from device ${deviceId}:`, JSON.stringify(data))

    // Offline
    if (data.online === false) {
      console.log(`[mqtt] device ${deviceId} went offline`)
      await db`UPDATE devices SET is_online = false WHERE device_id = ${deviceId}`
      broadcastDeviceStatus(deviceId, false)
      return
    }

    // Online
    if (data.online === true) {
      console.log(`[mqtt] device ${deviceId} online, fw=${data.fw}`)
      await db`
        UPDATE devices
        SET is_online  = true,
            last_seen  = NOW(),
            fw_version = COALESCE(${data.fw || null}, fw_version)
        WHERE device_id = ${deviceId}
      `
      broadcastDeviceStatus(deviceId, true)
    }

    // Обновление реле (если есть поле relays)
    if (data.relays && Array.isArray(data.relays)) {
      console.log(`[mqtt] processing relays, count=${data.relays.length}`)
      // Если это не онлайн-сообщение, всё равно обновляем last_seen
      if (!data.online) {
        await db`UPDATE devices SET last_seen = NOW() WHERE device_id = ${deviceId}`
      }

      for (const r of data.relays) {
        console.log(`[mqtt] updating relay name=${r.name}, state=${r.state}`)
        const [relay] = await db`
          UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
          WHERE device_id = ${deviceId} AND name = ${r.name}
          RETURNING id
        `
        if (relay) {
          console.log(`[mqtt] updated relay ${relay.id} to ${r.state}`)
          broadcastRelayStatus(relay.id, r.state)
        } else {
          console.log(`[mqtt] relay not found: name="${r.name}"`)
        }
      }
    }
  
  // Если не было ни online, ни relays – игнорируем
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

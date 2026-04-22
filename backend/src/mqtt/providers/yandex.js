'use strict'
// ── Yandex IoT Core provider ──────────────────────────────────
// Регистрация: YC REST API (IAM token + SA key)
// Соединение:  mqtts:// + TLS сертификаты
// Online:      LWT не работает → heartbeat timeout fallback

const fs     = require('fs')
const https  = require('https')
const crypto = require('crypto')

// LWT не поддерживается — используем heartbeat timeout
const supportsLWT = false

// Если устройство не присылало heartbeat N минут — считаем оффлайн
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000   // 3 минуты

// ── IAM токен ─────────────────────────────────────────────────
let _iamToken    = null
let _iamTokenExp = 0

async function getIamToken() {
  if (_iamToken && Date.now() < _iamTokenExp) return _iamToken

  const key = JSON.parse(fs.readFileSync(process.env.YC_SA_KEY_FILE, 'utf8'))
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: key.service_account_id,
    sub: key.service_account_id,
    aud: 'https://iam.api.cloud.yandex.net/iam/v1/tokens',
    iat: now,
    exp: now + 3600,
  }
  const header = Buffer.from(JSON.stringify({ alg: 'PS256', typ: 'JWT', kid: key.id })).toString('base64url')
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sign   = crypto.createSign('RSA-SHA256')
  sign.update(`${header}.${body}`)
  const sig = sign.sign(
    { key: key.private_key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    'base64url'
  )
  const jwt  = `${header}.${body}.${sig}`
  const data = await ycPost('iam.api.cloud.yandex.net', '/iam/v1/tokens', { jwt }, null)
  _iamToken    = data.iamToken
  _iamTokenExp = Date.now() + 55 * 60 * 1000
  return _iamToken
}

// ── HTTP helpers ──────────────────────────────────────────────
function ycPost(host, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = https.request({ hostname: host, path, method: 'POST', headers }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) return reject(new Error(`YC ${res.statusCode}: ${data}`))
          resolve(parsed)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function ycGet(host, path) {
  return new Promise(async (resolve, reject) => {
    const token   = await getIamToken()
    const headers = { 'Authorization': `Bearer ${token}` }
    const req = https.request({ hostname: host, path, method: 'GET', headers }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) return reject(new Error(`YC ${res.statusCode}: ${data}`))
          resolve(parsed)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function ycDelete(host, path) {
  return new Promise(async (resolve, reject) => {
    const token   = await getIamToken()
    const headers = { 'Authorization': `Bearer ${token}` }
    const req = https.request({ hostname: host, path, method: 'DELETE', headers }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => res.statusCode < 300 ? resolve(data) : reject(new Error(`YC DELETE ${res.statusCode}: ${data}`)))
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Топики ────────────────────────────────────────────────────
// ESP публикует в:  $devices/{ycId}/events
// Backend слушает: $devices/+/events и $devices/+/state

function topicsToSubscribe() {
  return [
    `$devices/+/events`,
    `$devices/+/events/#`,
    `$devices/+/state`,
  ]
}

// ── Разбор входящего сообщения ────────────────────────────────
async function parseMessage(topic, payload, db) {
  let data
  try { data = JSON.parse(payload) } catch { return null }

  // Извлечь ycDeviceId из топика ($devices/{id}/events[/...])
  const match = topic.match(/^\$devices\/([^/]+)\//)
  if (!match) return null
  const ycDeviceId = match[1]

  const [dev] = await db`SELECT device_id FROM devices WHERE mqtt_user = ${ycDeviceId}`
  if (!dev) return null

  const deviceId = dev.device_id

  // online / offline
  if (typeof data.online === 'boolean') {
    return { deviceId, online: data.online, fw: data.fw || null, relays: data.relays || null }
  }

  // heartbeat — ESP шлёт {type:"heartbeat", fw:"..."}
  if (data.type === 'heartbeat') {
    return { deviceId, online: true, fw: data.fw || null, relays: null }
  }

  // реле — [{name, state}] или {relays:[...]}
  const relays = Array.isArray(data) ? data : (data.relays || null)
  if (relays) {
    return { deviceId, online: null, fw: null, relays }
  }

  return null
}

// ── Опции подключения backend → YC ───────────────────────────
function getConnectOptions() {
  return {
    url: `mqtts://${process.env.MQTT_HOST || 'mqtt.cloud.yandex.net'}:${process.env.MQTT_PORT || 8883}`,
    options: {
      //protocolVersion:    5,
      clientId:           `janitor-backend-${Date.now()}`,
      clean:              true, //false,
      reconnectPeriod:    5000,
      connectTimeout:     10000,
      cert:               fs.readFileSync(process.env.MQTT_CERT_FILE),
      key:                fs.readFileSync(process.env.MQTT_KEY_FILE),
      ca:                 fs.readFileSync(process.env.MQTT_CA_FILE),
      rejectUnauthorized: true,
    },
  }
}

// ── Регистрация устройства в YC IoT ──────────────────────────
async function registerDevice({ deviceId, mqttPass }) {
  const registryId = process.env.YC_REGISTRY_ID
  const token      = await getIamToken()

  // Ищем существующее устройство
  const list = await ycGet('iot-devices.api.cloud.yandex.net',
    `/iot-devices/v1/devices?registryId=${registryId}`)
  let existing = (list.devices || []).find(d => d.name === deviceId)
  let ycDeviceId

  if (existing) {
    ycDeviceId = existing.id
    console.log(`[yandex] existing device: ${ycDeviceId}`)
  } else {
    const device = await ycPost('iot-devices.api.cloud.yandex.net',
      '/iot-devices/v1/devices', { registryId, name: deviceId }, token)
    // Ждём консистентности
    await new Promise(r => setTimeout(r, 1000))
    const list2 = await ycGet('iot-devices.api.cloud.yandex.net',
      `/iot-devices/v1/devices?registryId=${registryId}`)
    const found = (list2.devices || []).find(d => d.name === deviceId)
    if (!found) throw new Error(`YC device ${deviceId} not found after creation`)
    ycDeviceId = found.id
    console.log(`[yandex] created device: ${ycDeviceId}`)
  }

  // Удаляем старые пароли
  try {
    const pwds = await ycGet('iot-devices.api.cloud.yandex.net',
      `/iot-devices/v1/devices/${ycDeviceId}/passwords`)
    for (const p of (pwds.passwords || [])) {
      try {
        await ycDelete('iot-devices.api.cloud.yandex.net',
          `/iot-devices/v1/devices/${ycDeviceId}/passwords/${p.id}`)
      } catch {}
    }
  } catch {}

  // Создаём новый пароль
  await ycPost('iot-devices.api.cloud.yandex.net',
    `/iot-devices/v1/devices/${ycDeviceId}/passwords`,
    { deviceId: ycDeviceId, password: mqttPass }, token)

  return ycDeviceId  // это и будет mqtt_user для ESP
}

// ── Удаление устройства ───────────────────────────────────────
async function deleteDevice({ mqttUser }) {
  if (!mqttUser) return
  try {
    await ycDelete('iot-devices.api.cloud.yandex.net',
      `/iot-devices/v1/devices/${mqttUser}`)
    console.log(`[yandex] deleted device: ${mqttUser}`)
  } catch (e) {
    console.warn(`[yandex] delete error: ${e.message}`)
  }
}

async function ensureDeviceAccess() {
  // no-op для Yandex: права и пароль управляются IoT Core
}

async function repairExistingDevices() {
  // no-op для Yandex
}

// ── Конфиг для ESP ────────────────────────────────────────────
function getEspConfig({ mqttUser, mqttPass, mqttTopic }) {
  return {
    mqtt_host:   process.env.MQTT_ESP_HOST || 'mqtt.cloud.yandex.net',
    mqtt_port:   parseInt(process.env.MQTT_ESP_PORT || '8883'),
    mqtt_user:   mqttUser,
    mqtt_pass:   mqttPass,
    registry_id: process.env.YC_REGISTRY_ID,
    // mqtt_topic не используется в YC — ESP публикует в $devices/{id}/events
  }
}

module.exports = {
  supportsLWT,
  HEARTBEAT_TIMEOUT_MS,
  topicsToSubscribe,
  parseMessage,
  getConnectOptions,
  registerDevice,
  deleteDevice,
  getEspConfig,
}

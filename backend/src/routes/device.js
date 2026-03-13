'use strict'
const fs     = require('fs')
const https  = require('https')
const crypto = require('crypto')
const { getDb } = require('../db/connection')

// ── YC IoT Core API ──────────────────────────────────────────────────────────

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
  const header    = Buffer.from(JSON.stringify({ alg: 'PS256', typ: 'JWT', kid: key.id })).toString('base64url')
  const body      = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sign      = crypto.createSign('RSA-SHA256')
  sign.update(`${header}.${body}`)
  const signature = sign.sign({ key: key.private_key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, 'base64url')
  const jwt       = `${header}.${body}.${signature}`

  const data   = await ycPost('iam.api.cloud.yandex.net', '/iam/v1/tokens', { jwt }, null)
  _iamToken    = data.iamToken
  _iamTokenExp = Date.now() + 55 * 60 * 1000
  return _iamToken
}

function ycPost(host, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const req = https.request({ hostname: host, path, method: 'POST', headers }, (res) => {
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
    const req = https.request({ hostname: host, path, method: 'GET', headers }, (res) => {
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
    const req = https.request({ hostname: host, path, method: 'DELETE', headers }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { resolve(data) })
    })
    req.on('error', reject)
    req.end()
  })
}

async function createYcDevice(deviceName, password) {
  const registryId = process.env.YC_REGISTRY_ID
  const token      = await getIamToken()

  let ycDeviceId
  try {
    const device = await ycPost('iot-devices.api.cloud.yandex.net',
      '/iot-devices/v1/devices', { registryId, name: deviceName }, token)
    ycDeviceId = device.id || device.response?.id
  } catch (e) {
    const list = await ycGet('iot-devices.api.cloud.yandex.net',
      `/iot-devices/v1/devices?registryId=${registryId}`)
    const existing = (list.devices || []).find(d => d.name === deviceName)
    if (!existing) throw new Error('Failed to create or find YC device: ' + e.message)
    ycDeviceId = existing.id

    const pwds = await ycGet('iot-devices.api.cloud.yandex.net',
      `/iot-devices/v1/devices/${ycDeviceId}/passwords`)
    for (const p of (pwds.passwords || [])) {
      await ycDelete('iot-devices.api.cloud.yandex.net',
        `/iot-devices/v1/devices/passwords/${p.id}`)
    }
  }

  await ycPost('iot-devices.api.cloud.yandex.net',
    `/iot-devices/v1/devices/${ycDeviceId}/passwords`,
    { deviceId: ycDeviceId, password }, token)

  return ycDeviceId
}

async function deleteYcDevice(ycDeviceId) {
  if (!ycDeviceId) return
  try {
    await ycDelete('iot-devices.api.cloud.yandex.net',
      `/iot-devices/v1/devices/${ycDeviceId}`)
    console.log(`[yc] Device deleted: ${ycDeviceId}`)
  } catch (e) {
    console.warn(`[yc] Delete device error: ${e.message}`)
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function deviceRoutes(app) {

  app.post('/device/register', {
    schema: {
      body: {
        type: 'object',
        required: ['mac', 'code', 'relays'],
        properties: {
          mac:        { type: 'string' },
          fw_version: { type: 'string' },
          code:       { type: 'string', minLength: 6, maxLength: 6 },
          relays: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['index'],
              properties: {
                index: { type: 'integer', minimum: 0, maximum: 7 },
                pin:   { type: 'integer' },
                name:  { type: 'string' },
              }
            }
          }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { mac, fw_version, code, relays } = req.body

    const deviceId = mac.replace(/[:\-]/g, '').toUpperCase()
    if (deviceId.length !== 12) return reply.code(400).send({ error: 'invalid_mac' })

    const [token] = await db`
      SELECT dt.group_id, g.name AS group_name
      FROM device_tokens dt
      JOIN groups g ON g.id = dt.group_id
      WHERE dt.code = ${code} AND dt.expires_at > NOW()
    `
    if (!token) return reply.code(400).send({ error: 'invalid_or_expired_code' })

    const mqttPass = generatePassword()

    let ycDeviceId
    try {
      ycDeviceId = await createYcDevice(deviceId, mqttPass)
      console.log(`[register] YC device: ${ycDeviceId} for ${deviceId}`)
    } catch (err) {
      console.error('[register] YC error:', err.message)
      return reply.code(500).send({ error: 'yc_device_error' })
    }

    await db`
      INSERT INTO devices (device_id, group_id, mqtt_user, mqtt_password, fw_version, registered_at)
      VALUES (${deviceId}, ${token.group_id}, ${ycDeviceId}, ${mqttPass}, ${fw_version || null}, NOW())
      ON CONFLICT (device_id) DO UPDATE
        SET group_id      = ${token.group_id},
            mqtt_user     = ${ycDeviceId},
            mqtt_password = ${mqttPass},
            fw_version    = COALESCE(${fw_version || null}, devices.fw_version),
            registered_at = NOW()
    `

    for (const relay of relays) {
      const relayName = (relay.name || `Relay ${relay.index}`).trim()
      await db`
        INSERT INTO relays (device_id, relay_index, name)
        VALUES (${deviceId}, ${relay.index}, ${relayName})
        ON CONFLICT (device_id, relay_index) DO UPDATE
          SET name = ${relayName}
      `
    }

    await db`DELETE FROM device_tokens WHERE code = ${code}`

    await db`
      INSERT INTO event_log (action, target_type, target_id, group_id, payload)
      VALUES ('device_registered', 'device', ${deviceId}, ${token.group_id},
              ${JSON.stringify({ mac: deviceId, fw_version, relay_count: relays.length })})
    `

    return {
      ok:          true,
      mqtt_host:   process.env.MQTT_HOST || 'mqtt.cloud.yandex.net',
      mqtt_port:   parseInt(process.env.MQTT_PORT || '8883'),
      mqtt_user:   ycDeviceId,
      mqtt_pass:   mqttPass,
      registry_id: process.env.YC_REGISTRY_ID,
    }
  })
}

function generatePassword(len = 24) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(len)
  let pass = ''
  for (let i = 0; i < len; i++) pass += chars[bytes[i] % chars.length]
  return pass
}

module.exports = deviceRoutes
module.exports.deleteYcDevice = deleteYcDevice

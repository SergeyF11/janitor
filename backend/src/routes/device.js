'use strict'
const crypto    = require('crypto')
const { getDb } = require('../db/connection')
const provider  = require('../mqtt/provider')

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
      SELECT dt.group_id, g.name AS group_name, g.mqtt_topic
      FROM device_tokens dt
      JOIN groups g ON g.id = dt.group_id
      WHERE dt.code = ${code} AND dt.expires_at > NOW()
    `
    if (!token) return reply.code(400).send({ error: 'invalid_or_expired_code' })

    const mqttPass = generatePassword()

    // mqtt_user зависит от провайдера:
    //   local  — esp_{MAC}
    //   yandex — YC device ID (возвращается из registerDevice)
    const localMqttUser = `esp_${deviceId}`
    let mqttUser = localMqttUser

    try {
      const result = await provider.registerDevice({
        deviceId,
        mqttUser:  localMqttUser,
        mqttPass,
        mqttTopic: token.mqtt_topic,
      })
      // Яндекс возвращает ycDeviceId как mqttUser
      if (result) mqttUser = result
    } catch (err) {
      console.error('[register] provider error:', err.message)
      return reply.code(500).send({ error: 'mqtt_provider_error', detail: err.message })
    }

    await db`
      INSERT INTO devices (device_id, group_id, mqtt_user, mqtt_password, fw_version, registered_at)
      VALUES (${deviceId}, ${token.group_id}, ${mqttUser}, ${mqttPass}, ${fw_version || null}, NOW())
      ON CONFLICT (device_id) DO UPDATE
        SET group_id      = ${token.group_id},
            mqtt_user     = ${mqttUser},
            mqtt_password = ${mqttPass},
            fw_version    = COALESCE(${fw_version || null}, devices.fw_version),
            registered_at = NOW()
    `

    for (const relay of relays) {
      const name = (relay.name || `Relay ${relay.index}`).trim()
      await db`
        INSERT INTO relays (device_id, relay_index, name)
        VALUES (${deviceId}, ${relay.index}, ${name})
        ON CONFLICT (device_id, relay_index) DO UPDATE SET name = ${name}
      `
    }

    await db`DELETE FROM device_tokens WHERE code = ${code}`

    await db`
      INSERT INTO event_log (action, target_type, target_id, group_id, payload)
      VALUES ('device_registered', 'device', ${deviceId}, ${token.group_id},
              ${JSON.stringify({ mac: deviceId, fw_version, relay_count: relays.length, provider: process.env.MQTT_PROVIDER || 'local' })})
    `

    const espConfig = provider.getEspConfig({ mqttUser, mqttPass, mqttTopic: token.mqtt_topic })
    return { ok: true, ...espConfig }
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


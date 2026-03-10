'use strict'
const { getDb } = require('../db/connection')
const { createDeviceClient } = require('../mqtt/dynsec')

async function deviceRoutes(app) {

  // POST /api/device/register
  //
  // ESP регистрирует УСТРОЙСТВО одним кодом.
  // Все реле устройства получают один общий MQTT топик группы.
  //
  // Запрос:
  // {
  //   mac:        "BC:FF:4D:4A:71:F2",
  //   fw_version: "1.2.0",
  //   code:       "141124",           // один код на устройство
  //   relays: [
  //     { index: 0, pin: 5,  name: "Ворота" },
  //     { index: 1, pin: 12, name: "Шлагбаум" }
  //   ]
  // }
  //
  // Ответ:
  // {
  //   ok:         true,
  //   mqtt_host:  "smilart.ru",
  //   mqtt_port:  8883,
  //   mqtt_user:  "esp_BCFF4D4A71F2",
  //   mqtt_pass:  "...",
  //   mqtt_topic: "building_a"        // один топик для всех реле
  // }
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
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['index'],
              properties: {
                index: { type: 'integer', minimum: 0, maximum: 7 },
                pin:   { type: 'integer' },
                name:  { type: 'string'  },
              }
            }
          }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { mac, fw_version, code, relays } = req.body

    const macClean = mac.replace(/[:\-]/g, '').toUpperCase()
    if (macClean.length !== 12) {
      return reply.code(400).send({ error: 'invalid_mac' })
    }

    // Проверяем код привязки
    const [token] = await db`
      SELECT dt.group_id, g.mqtt_topic, g.relay_duration_ms, g.name AS group_name
      FROM device_tokens dt
      JOIN groups g ON g.id = dt.group_id
      WHERE dt.code = ${code}
        AND dt.expires_at > NOW()
    `

    if (!token) {
      return reply.code(400).send({ error: 'invalid_or_expired_code' })
    }

    const { group_id, mqtt_topic } = token

    // MQTT credentials для устройства
    const mqttUser = `esp_${macClean}`
    const mqttPass = generatePassword()

    // Upsert device
    await db`
      INSERT INTO devices (device_id, mqtt_user, mqtt_pass_hash, fw_version, registered_at)
      VALUES (${macClean}, ${mqttUser}, ${mqttPass}, ${fw_version || null}, NOW())
      ON CONFLICT (device_id) DO UPDATE
        SET mqtt_user      = ${mqttUser},
            mqtt_pass_hash = ${mqttPass},
            fw_version     = COALESCE(${fw_version || null}, devices.fw_version),
            registered_at  = NOW()
    `

    // Привязать все реле устройства к одной группе
    for (const relay of relays) {
      await db`
        INSERT INTO device_groups (device_id, group_id, relay_index)
        VALUES (${macClean}, ${group_id}, ${relay.index})
        ON CONFLICT (device_id, group_id, relay_index) DO UPDATE
          SET relay_index = ${relay.index}
      `
    }

    // Удалить использованный токен
    await db`DELETE FROM device_tokens WHERE code = ${code}`

    // Зарегистрировать устройство в Mosquitto Dynamic Security
    try {
      await createDeviceClient(mqttUser, mqttPass, macClean, mqtt_topic)
    } catch (err) {
      console.error('[mqtt] dynsec error:', err.message)
    }

    await db`
      INSERT INTO event_log (action, target_type, target_id, group_id, payload)
      VALUES ('device_registered', 'device', ${macClean}, ${group_id},
              ${JSON.stringify({
                mac:        macClean,
                fw_version,
                mqtt_topic,
                relay_count: relays.length,
                relays:      relays.map(r => ({ index: r.index, pin: r.pin, name: r.name })),
              })})
    `

    return {
      ok:         true,
      mqtt_host:  process.env.MQTT_HOST || 'smilart.ru',
      mqtt_port:  parseInt(process.env.MQTT_PORT || '8883'),
      mqtt_user:  mqttUser,
      mqtt_pass:  mqttPass,
      mqtt_topic, // один топик для всех реле
    }
  })
}

function generatePassword(len = 24) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const { randomBytes } = require('crypto')
  const bytes = randomBytes(len)
  let pass = ''
  for (let i = 0; i < len; i++) pass += chars[bytes[i] % chars.length]
  return pass
}

module.exports = deviceRoutes
'use strict'
const { getDb } = require('../db/connection')
const { createDeviceClient } = require('../mqtt/dynsec')

async function deviceRoutes(app) {

  // POST /api/device/register
  //
  // ESP регистрирует устройство одним кодом.
  // Каждое реле привязывается к группе по имени: relay.name == group.mqtt_topic
  //
  // Запрос:
  // {
  //   mac:        "BC:FF:4D:4A:71:F2",
  //   fw_version: "1.3.0",
  //   code:       "141124",
  //   relays: [
  //     { index: 0, pin: 5,  name: "test" },    // имя реле = mqtt_topic группы
  //     { index: 1, pin: 12, name: "gate" }
  //   ]
  // }
  //
  // Ответ:
  // {
  //   ok:        true,
  //   mqtt_host: "smilart.ru",
  //   mqtt_port: 8883,
  //   mqtt_user: "esp_BCFF4D4A71F2",
  //   mqtt_pass: "...",
  //   device_id: "BCFF4D4A71F2",
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

    // MQTT credentials для устройства
    const mqttUser = `esp_${macClean}`
    const mqttPass = generatePassword()

    // Upsert device
    await db`
      INSERT INTO devices (device_id, mqtt_user, mqtt_password, fw_version, registered_at)
      VALUES (${macClean}, ${mqttUser}, ${mqttPass}, ${fw_version || null}, NOW())
      ON CONFLICT (device_id) DO UPDATE
        SET mqtt_user     = ${mqttUser},
            mqtt_password = ${mqttPass},
            fw_version    = COALESCE(${fw_version || null}, devices.fw_version),
            registered_at = NOW()
    `

    // Привязать каждое реле к группе по имени (relay.name == group.mqtt_topic)
    // Реле без совпадения пропускаются (имя не совпадает ни с одной группой)
    const registeredRelays = []
    for (const relay of relays) {
      const relayName = (relay.name || '').trim()
      if (!relayName) continue

      const [group] = await db`
        SELECT id, mqtt_topic FROM groups
        WHERE name = ${relayName}
          AND status = 'active'
        LIMIT 1
      `

      if (!group) {
        console.warn(`[register] relay[${relay.index}] name="${relayName}" — no matching group, skipping`)
        continue
      }

      await db`
        INSERT INTO device_groups (device_id, group_id, relay_index)
        VALUES (${macClean}, ${group.id}, ${relay.index})
        ON CONFLICT (device_id, group_id, relay_index) DO UPDATE
          SET relay_index = ${relay.index}
      `
      registeredRelays.push({ index: relay.index, group: group.mqtt_topic })
    }

    // Удалить использованный токен
    await db`DELETE FROM device_tokens WHERE code = ${code}`

    // Зарегистрировать устройство в Mosquitto Dynamic Security
    try {
      await createDeviceClient(mqttUser, mqttPass, macClean)
    } catch (err) {
      console.error('[mqtt] dynsec error:', err.message)
    }

    await db`
      INSERT INTO event_log (action, target_type, target_id, group_id, payload)
      VALUES ('device_registered', 'device', ${macClean}, ${token.group_id},
              ${JSON.stringify({
                mac:        macClean,
                fw_version,
                relay_count: relays.length,
                relays:      registeredRelays,
              })})
    `

    return {
      ok:        true,
      mqtt_host: process.env.MQTT_ESP_HOST || process.env.MQTT_HOST || 'smilart.ru',
      mqtt_port: parseInt(process.env.MQTT_ESP_PORT || process.env.MQTT_PORT || '8883'),
      mqtt_user: mqttUser,
      mqtt_pass: mqttPass,
      device_id: macClean,
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
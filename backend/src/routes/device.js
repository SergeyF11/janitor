'use strict'
const { getDb } = require('../db/connection')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// Пути к файлам mosquitto (монтируются через docker volume)
const MOSQUITTO_PASSWD = process.env.MOSQUITTO_PASSWD_FILE || '/mosquitto/config/passwd'
const MOSQUITTO_ACL    = process.env.MOSQUITTO_ACL_FILE    || '/mosquitto/config/acl'
const MOSQUITTO_CTR    = process.env.MOSQUITTO_CONTAINER   || 'janitor-mosquitto'

async function deviceRoutes(app) {

  // POST /api/device/register — регистрация ESP по коду привязки
  // Вызывается с ESP в CaptivePortal при наличии полного интернета
  app.post('/device/register', {
    schema: {
      body: {
        type: 'object',
        required: ['code', 'mac', 'relay_index'],
        properties: {
          code:        { type: 'string', minLength: 6, maxLength: 6 },
          mac:         { type: 'string' },                          // AA:BB:CC:DD:EE:FF
          relay_index: { type: 'integer', minimum: 0, maximum: 7 },
          fw_version:  { type: 'string' },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { code, mac, relay_index, fw_version } = req.body

    // Нормализовать MAC → AABBCCDDEEFF
    const macClean = mac.replace(/[:\-]/g, '').toUpperCase()
    if (macClean.length !== 12) {
      return reply.code(400).send({ error: 'invalid_mac' })
    }

    // Проверить код привязки
    const [token] = await db`
      SELECT dt.group_id, dt.expires_at, g.mqtt_topic, g.relay_duration_ms
      FROM device_tokens dt
      JOIN groups g ON g.id = dt.group_id
      WHERE dt.code = ${code} AND dt.expires_at > NOW()
    `
    if (!token) {
      return reply.code(404).send({ error: 'invalid_or_expired_code' })
    }

    const groupId   = token.group_id
    const mqttTopic = token.mqtt_topic

    // MQTT credentials для ESP
    const mqttUser = `esp_${macClean}`
    const mqttPass = generatePassword()

    // Upsert device
    await db`
      INSERT INTO devices (device_id, mqtt_user, mqtt_pass_hash, fw_version, registered_at)
      VALUES (${macClean}, ${mqttUser}, ${mqttPass}, ${fw_version || null}, NOW())
      ON CONFLICT (device_id) DO UPDATE
        SET mqtt_user      = ${mqttUser},
            mqtt_pass_hash = ${mqttPass},
            fw_version     = ${fw_version || null},
            registered_at  = NOW()
    `

    // Привязать к группе с relay_index
    await db`
      INSERT INTO device_groups (device_id, group_id, relay_index)
      VALUES (${macClean}, ${groupId}, ${relay_index})
      ON CONFLICT (device_id, group_id, relay_index) DO NOTHING
    `

    // Удалить использованный токен
    await db`DELETE FROM device_tokens WHERE group_id = ${groupId}`

    // Обновить mosquitto passwd и ACL
    try {
      await updateMosquittoPasswd(mqttUser, mqttPass)
      await updateMosquittoAcl(mqttUser, macClean, mqttTopic)
      await reloadMosquitto()
    } catch (err) {
      console.error('[mqtt] mosquitto update error:', err.message)
      // Не фатально — можно обновить вручную
    }

    await db`
      INSERT INTO event_log (action, target_type, target_id, group_id, payload)
      VALUES ('device_registered', 'device', ${macClean}, ${groupId},
              ${JSON.stringify({ mac: macClean, relay_index, fw_version, mqtt_topic: mqttTopic })})
    `

    // Вернуть ESP всё необходимое для работы
    return {
      ok:           true,
      mqtt_user:    mqttUser,
      mqtt_pass:    mqttPass,
      mqtt_host:    process.env.MQTT_HOST    || 'smilart.ru',
      mqtt_port:    parseInt(process.env.MQTT_PORT || '8883'),
      relay_topic:  `relay/${mqttTopic}`,
      status_topic: `sys/devices/${macClean}/status`,
      hb_topic:     `sys/devices/${macClean}/heartbeat`,
    }
  })

  // POST /api/device/heartbeat — ESP сообщает что живёт
  // Можно вызывать без аутентификации — проверяем по mqtt_user + mac
  app.post('/device/heartbeat', {
    schema: {
      body: {
        type: 'object',
        required: ['device_id'],
        properties: {
          device_id:  { type: 'string' },
          fw_version: { type: 'string' },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { device_id, fw_version } = req.body
    const macClean = device_id.replace(/[:\-]/g, '').toUpperCase()

    const result = await db`
      UPDATE devices
      SET last_seen  = NOW(),
          fw_version = COALESCE(${fw_version || null}, fw_version)
      WHERE device_id = ${macClean}
      RETURNING device_id
    `
    if (!result.length) return reply.code(404).send({ error: 'unknown_device' })
    return { ok: true }
  })
}

// ── Вспомогательные функции ───────────────────────────────────

function generatePassword(len = 24) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let pass = ''
  const { randomBytes } = require('crypto')
  const bytes = randomBytes(len)
  for (let i = 0; i < len; i++) {
    pass += chars[bytes[i] % chars.length]
  }
  return pass
}

async function updateMosquittoPasswd(user, pass) {
  // mosquitto_passwd -b <файл> <user> <pass>
  execSync(`mosquitto_passwd -b ${MOSQUITTO_PASSWD} ${user} ${pass}`)
}

async function updateMosquittoAcl(user, macClean, mqttTopic) {
  const marker = `# Device ${macClean}`
  const entry = `
${marker}
user ${user}
topic read relay/${mqttTopic}/trigger
topic write relay/${mqttTopic}/status
topic write sys/devices/${macClean}/#
topic read  sys/devices/${macClean}/#

`
  let content = ''
  try {
    content = fs.readFileSync(MOSQUITTO_ACL, 'utf8')
  } catch {
    content = ''
  }

  // Удалить старую запись устройства если есть
  const idx = content.indexOf(marker)
  if (idx >= 0) {
    const next = content.indexOf('\n# Device ', idx + 1)
    content = content.substring(0, idx) + (next >= 0 ? content.substring(next + 1) : '')
  }

  fs.writeFileSync(MOSQUITTO_ACL, content + entry)
}

async function reloadMosquitto() {
  execSync(`docker kill --signal=HUP ${MOSQUITTO_CTR}`)
}

module.exports = deviceRoutes
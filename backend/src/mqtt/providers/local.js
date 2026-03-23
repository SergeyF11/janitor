'use strict'
// ── Local Mosquitto provider ──────────────────────────────────
// Регистрация: dynsec через MQTT API ($CONTROL/dynamic-security/v1/request)
// Соединение:  mqtt:// без TLS (внутри Docker)
// Online:      LWT — нативно, heartbeat не нужен

const MQTT_HOST = () => process.env.MQTT_LOCAL_HOST     || 'janitor-mosquitto'
const MQTT_PORT = () => process.env.MQTT_LOCAL_PORT     || '1883'
const MQTT_USER = () => process.env.MQTT_ADMIN_USER     || 'mqttadmin'
const MQTT_PASS = () => process.env.MQTT_ADMIN_PASSWORD || ''

const ESP_HOST  = () => process.env.MQTT_HOST || 'smilart.ru'
const ESP_PORT  = () => parseInt(process.env.MQTT_PORT || '8883')

// true — LWT работает нативно, heartbeat fallback не нужен
const supportsLWT = true

// ── Топики ────────────────────────────────────────────────────
// ESP публикует:
//   sys/devices/{MAC}/status  — {"online":true/false, "fw_version":"..."}  (LWT = {"online":false})
//   relay/{topic}/status      — {"relays":[{"index":0,"state":"on"}]}
// Backend слушает:
//   sys/devices/+/status
//   relay/+/status

function topicsToSubscribe() {
  return [
    'sys/devices/+/status',
    'relay/+/status',
  ]
}

// ── Разбор входящего сообщения ────────────────────────────────
// Возвращает { deviceId, online, fw, relays } или null
async function parseMessage(topic, payload, db) {
  let data
  try { data = JSON.parse(payload) } catch { return null }

  // sys/devices/<MAC>/status
  const statusMatch = topic.match(/^sys\/devices\/([^/]+)\/status$/)
  if (statusMatch) {
    const deviceId = statusMatch[1]
    const online   = data.online !== false
    return { deviceId, online, fw: data.fw_version || null, relays: null }
  }

  // relay/<topic>/status
  const relayMatch = topic.match(/^relay\/([^/]+)\/status$/)
  if (relayMatch) {
    const mqttTopic = relayMatch[1]
    const [dev] = await db`
      SELECT d.device_id FROM devices d
      JOIN groups g ON g.id = d.group_id
      WHERE g.mqtt_topic = ${mqttTopic}
    `
    if (!dev) return null
    return {
      deviceId: dev.device_id,
      online:   data.online !== undefined ? data.online !== false : true,
      fw:       data.fw || null,
      relays:   data.relays || null,
    }
  }

  return null
}

// ── Опции подключения backend → Mosquitto ─────────────────────
function getConnectOptions() {
  return {
    url: `mqtt://${MQTT_HOST()}:${MQTT_PORT()}`,
    options: {
      username:           MQTT_USER(),
      password:           MQTT_PASS(),
      clientId:           `janitor-backend-${Date.now()}`,
      clean:              true,
      reconnectPeriod:    5000,
      connectTimeout:     10000,
      rejectUnauthorized: false,
    },
  }
}

// ── Регистрация устройства через dynsec MQTT API ─────────────
async function registerDevice({ deviceId, mqttUser, mqttPass, mqttTopic }) {
  const roleName = `role_${deviceId}`

  // Шаг 1: удаляем старое (ошибки "not found" ожидаемы)
  await _dynsecSend([
    { command: 'deleteClient', username: mqttUser  },
    { command: 'deleteRole',   rolename: roleName  },
  ]).catch(() => {})

  // Шаг 2: создаём пользователя, роль и ACL
  await _dynsecSend([
    { command: 'createClient',      username: mqttUser },
    { command: 'setClientPassword', username: mqttUser, password: mqttPass },
    { command: 'createRole',    rolename: roleName },
    { command: 'addRoleACL',    rolename: roleName,
      acltype: 'subscribePattern',  topic: `relay/${mqttTopic}/cmd`,         allow: true },
    { command: 'addRoleACL',    rolename: roleName,
      acltype: 'publishClientSend', topic: `relay/${mqttTopic}/status`,      allow: true },
    { command: 'addRoleACL',    rolename: roleName,
      acltype: 'publishClientSend', topic: `sys/devices/${deviceId}/status`, allow: true },
    { command: 'addClientRole', username: mqttUser, rolename: roleName },
  ])

  console.log(`[local] dynsec OK: user=${mqttUser} topic=relay/${mqttTopic}/cmd`)
}

// ── Dynsec через отдельное MQTT соединение ───────────────────
// Используем отдельный клиент чтобы не мешать основному соединению.
// Подписываемся на wildcard чтобы поймать ответ независимо от subtopic.
function _dynsecSend(commands) {
  const mqtt = require('mqtt')
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://${MQTT_HOST()}:${MQTT_PORT()}`, {
      username:           MQTT_USER(),
      password:           MQTT_PASS(),
      clientId:           `dynsec_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      clean:              true,
      connectTimeout:     5000,
      reconnectPeriod:    0,   // не переподключаться
    })

    const timer = setTimeout(() => {
      client.end(true)
      reject(new Error('dynsec timeout'))
    }, 8000)

    client.once('connect', () => {
      // Подписываемся на все ответы dynsec (включая subtopic /request/response)
      client.subscribe('$CONTROL/dynamic-security/v1/#', { qos: 1 }, () => {
        client.publish(
          '$CONTROL/dynamic-security/v1/request',
          JSON.stringify({ commands }),
          { qos: 1 }
        )
      })

      client.on('message', (topic, payload) => {
        // Игнорируем echo нашего же запроса
        if (topic === '$CONTROL/dynamic-security/v1/request') return
        clearTimeout(timer)
        client.end()
        try {
          const resp = JSON.parse(payload.toString())
          // "endpoint not available" — retained мусор, игнорируем
          if (resp.error === 'endpoint not available') {
            resolve({ responses: [] })
            return
          }
          const errors = (resp.responses || []).filter(r =>
            r.error &&
            !r.error.toLowerCase().includes('not found') &&
            !r.error.toLowerCase().includes('already exists')
          )
          if (errors.length > 0) reject(new Error(JSON.stringify(errors)))
          else resolve(resp)
        } catch (e) { reject(e) }
      })
    })

    client.once('error', err => {
      clearTimeout(timer)
      client.end(true)
      reject(err)
    })
  })
}

// ── Удаление устройства ───────────────────────────────────────
async function deleteDevice({ mqttUser, deviceId }) {
  const roleName = `role_${deviceId}`
  await _dynsecSend([
    { command: 'deleteClient', username: mqttUser  },
    { command: 'deleteRole',   rolename: roleName  },
  ]).catch(() => {})
  console.log(`[local] dynsec deleted: user=${mqttUser}`)
}

// ── Конфиг для ESP в ответе на регистрацию ───────────────────
function getEspConfig({ mqttUser, mqttPass, mqttTopic }) {
  return {
    mqtt_host:  ESP_HOST(),
    mqtt_port:  ESP_PORT(),
    mqtt_user:  mqttUser,
    mqtt_pass:  mqttPass,
    mqtt_topic: mqttTopic,
  }
}

module.exports = {
  supportsLWT,
  topicsToSubscribe,
  parseMessage,
  getConnectOptions,
  registerDevice,
  deleteDevice,
  getEspConfig,
}
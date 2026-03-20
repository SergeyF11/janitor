'use strict'
// ── Local Mosquitto provider ──────────────────────────────────
// Регистрация: dynsec через mosquitto_ctrl
// Соединение:  mqtt:// без TLS (внутри Docker)
// Online:      LWT — нативно, heartbeat не нужен

const { execSync } = require('child_process')

const MQTT_HOST = () => process.env.MQTT_HOST     || 'janitor-mosquitto'
const MQTT_PORT = () => process.env.MQTT_PORT     || '1883'
const MQTT_USER = () => process.env.MQTT_USER     || 'mqttadmin'
const MQTT_PASS = () => process.env.MQTT_PASSWORD || ''

const ESP_HOST  = () => process.env.MQTT_ESP_HOST || 'smilart.ru'
const ESP_PORT  = () => parseInt(process.env.MQTT_ESP_PORT || '8883')

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
    // Найти устройство по mqtt_topic группы
    const [dev] = await db`
      SELECT d.device_id FROM devices d
      JOIN groups g ON g.id = d.group_id
      WHERE g.mqtt_topic = ${mqttTopic}
    `
    if (!dev) return null
    return {
      deviceId: dev.device_id,
      online:   null,   // не меняем статус — только реле
      fw:       null,
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

// ── Регистрация устройства в Mosquitto через dynsec ───────────
async function registerDevice({ deviceId, mqttUser, mqttPass, mqttTopic }) {
  const roleName = `role_${deviceId}`
  const base = `mosquitto_ctrl -h ${MQTT_HOST()} -p ${MQTT_PORT()} -u ${MQTT_USER()} -P "${MQTT_PASS()}" dynsec`

  // Шаг 1: удаляем старое (ошибки ожидаемы)
  for (const cmd of [`deleteClient ${mqttUser}`, `deleteRole ${roleName}`]) {
    try { execSync(`${base} ${cmd}`, { stdio: 'pipe' }) } catch {}
  }

  // Шаг 2: создаём пользователя (пароль через stdin)
  execSync(`${base} createClient ${mqttUser}`, {
    input: `${mqttPass}\n${mqttPass}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Шаг 3: создаём роль с ACL
  execSync(`${base} createRole ${roleName}`, { stdio: 'pipe' })
  execSync(`${base} addRoleACL ${roleName} subscribePattern "relay/${mqttTopic}/cmd" allow`,       { stdio: 'pipe' })
  execSync(`${base} addRoleACL ${roleName} publishClientSend "relay/${mqttTopic}/status" allow`,   { stdio: 'pipe' })
  execSync(`${base} addRoleACL ${roleName} publishClientSend "sys/devices/${deviceId}/status" allow`, { stdio: 'pipe' })
  execSync(`${base} addClientRole ${mqttUser} ${roleName}`, { stdio: 'pipe' })

  console.log(`[local] dynsec OK: user=${mqttUser} topic=relay/${mqttTopic}/cmd`)
}

// ── Удаление устройства ───────────────────────────────────────
async function deleteDevice({ mqttUser, deviceId }) {
  const roleName = `role_${deviceId}`
  const base = `mosquitto_ctrl -h ${MQTT_HOST()} -p ${MQTT_PORT()} -u ${MQTT_USER()} -P "${MQTT_PASS()}" dynsec`
  try { execSync(`${base} deleteClient ${mqttUser}`, { stdio: 'pipe' }) } catch {}
  try { execSync(`${base} deleteRole ${roleName}`,   { stdio: 'pipe' }) } catch {}
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

'use strict'
// ── Local Mosquitto provider ──────────────────────────────────
// Регистрация: dynsec через MQTT API ($CONTROL/dynamic-security/v1)
// Соединение:  mqtt:// без TLS (внутри Docker)
// Online:      LWT — нативно, heartbeat не нужен
const mqtt = require('mqtt')

const MQTT_HOST = () => process.env.MQTT_LOCAL_HOST     || 'janitor-mosquitto'
const MQTT_PORT = () => process.env.MQTT_LOCAL_PORT     || '1883'
const MQTT_USER = () => process.env.MQTT_ADMIN_USER     || 'mqttadmin'
const MQTT_PASS = () => process.env.MQTT_ADMIN_PASSWORD || ''

// const ESP_HOST  = () => process.env.MQTT_HOST || 'smilart.ru'
// const ESP_PORT  = () => parseInt(process.env.MQTT_PORT || '8883')

const ESP_HOST  = () => process.env.MQTT_ESP_HOST || process.env.MQTT_HOST || 'smilart.ru'
const ESP_PORT  = () => parseInt(process.env.MQTT_ESP_PORT || process.env.MQTT_PORT || '8883')

const DYNSEC_CONTROL_TOPIC  = '$CONTROL/dynamic-security/v1'
const DYNSEC_RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response'
const DYNSEC_TIMEOUT_MS     = 8000

// true — LWT работает нативно, heartbeat fallback не нужен
const supportsLWT = true

// ── Топики ────────────────────────────────────────────────────
// ESP публикует:
//   $devices/{mqtt_user}/events — {"online":true/false, "fw":"...", "relays":[...]}

              // Legacy (обратная совместимость):
              //   sys/devices/{MAC}/status  — {"online":true/false, "fw_version":"..."}  (LWT = {"online":false})
              //   relay/{topic}/status      — {"relays":[{"index":0,"state":"on"}]}
// Backend слушает:
//   $devices/+/events

              //   sys/devices/+/status
              //   relay/+/status

function topicsToSubscribe() {
  return [
    '$devices/+/events',
    // 'sys/devices/+/status',
    // 'relay/+/status',
  ]
}

// ── Разбор входящего сообщения ────────────────────────────────
// Возвращает { deviceId, online, fw, relays } или null
async function parseMessage(topic, payload, db) {
  let data
  try { data = JSON.parse(payload) } catch { return null }

    // $devices/<mqtt_user>/events — унифицированный локальный/Yandex-style формат
  const eventMatch = topic.match(/^\$devices\/([^/]+)\/events$/)
  if (eventMatch) {
    const mqttUser = eventMatch[1]
    const [dev] = await db`
      SELECT device_id FROM devices
      WHERE mqtt_user = ${mqttUser}
    `
    if (!dev) return null

    const relays = Array.isArray(data) ? data : (data.relays || null)
    return {
      deviceId: dev.device_id,
      online:   Array.isArray(data) ? null : (data.online !== undefined ? data.online !== false : null),
      fw:       Array.isArray(data) ? null : (data.fw || data.fw_version || null),
      relays,
    }
  }

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
  
  await _dynsecCommand('deleteClient', { username: mqttUser }).catch(() => {})
  await _dynsecCommand('deleteRole',   { rolename: roleName }).catch(() => {})

  // Шаг 2: создаём пользователя с паролем сразу, чтобы исключить рассинхрон БД ↔ dynsec.
  await _dynsecCommand('createClient', {
    username: mqttUser,
    password: mqttPass,
    textname: `ESP ${deviceId}`,
    roles: [],
  })

  // Шаг 3: создаём роль с ACL.
  await _dynsecCommand('createRole', { rolename: roleName }).catch(() => {})

  const acls = [
    // Унифицированный Yandex-style протокол для local режима.
    { acltype: 'subscribePattern',  topic: `$devices/${mqttUser}/commands`, allow: true },
    { acltype: 'publishClientReceive', topic: `$devices/${mqttUser}/commands`, allow: true },
    { acltype: 'publishClientSend', topic: `$devices/${mqttUser}/events`,   allow: true },
          // Legacy local topics — оставляем для обратной совместимости со старой прошивкой/утилитами.
          // { acltype: 'subscribeLiteral',  topic: `relay/${mqttTopic}/cmd`,         allow: true },
          // { acltype: 'publishClientSend', topic: `relay/${mqttTopic}/status`,      allow: true },
          // { acltype: 'publishClientSend', topic: `sys/devices/${deviceId}/status`, allow: true },
  ]

  for (const acl of acls) {
    await _dynsecCommand('addRoleACL', { rolename: roleName, ...acl }).catch(err => {
      if (!_isIgnorableDynsecError(err)) throw err
    })
  }

  await _dynsecCommand('addClientRole', {
    username: mqttUser,
    rolename: roleName,
    priority: -1,
  })

  console.log(`[local] dynsec OK: user=${mqttUser} topic=$devices/${mqttUser}/commands`)
}

// ── Dynsec через отдельное MQTT соединение ───────────────────
// Используем отдельный клиент чтобы не мешать основному соединению.
// Подписываемся на wildcard чтобы поймать ответ независимо от subtopic.
//function _dynsecSend(commands) {
function _dynsecCommand(command, payload = {}) {
  //const mqtt = require('mqtt')
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
        reject(new Error(`dynsec timeout: ${command}`))
    }, DYNSEC_TIMEOUT_MS)

    client.once('connect', () => {
      // Подписываемся на все ответы dynsec (включая subtopic /request/response)
      client.subscribe(DYNSEC_RESPONSE_TOPIC, { qos: 1 }, err => {
        if (err) {
          clearTimeout(timer)
          client.end(true)
          reject(err)
          return
        }
        client.publish(
          DYNSEC_CONTROL_TOPIC,
          JSON.stringify({ commands: [{ command, ...payload }] }),
          { qos: 1 }
        )
      })

      client.on('message', (topic, responsePayload) => {
        if (topic !== DYNSEC_RESPONSE_TOPIC) return

        try {
          const resp = JSON.parse(responsePayload.toString())
          const result = resp.responses?.[0]
          if (!result || result.command !== command) return
          clearTimeout(timer)
          client.end()
          if (result.error && !_isIgnorableDynsecError(result.error)) {
            reject(new Error(`dynsec ${command}: ${result.error}`))
            return
          }
          resolve(result.data || {})
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

function _isIgnorableDynsecError(error) {
  const message = String(error || '').toLowerCase()
  return message.includes('not found') || message.includes('already exists')
}

// ── Удаление устройства ───────────────────────────────────────
async function deleteDevice({ mqttUser, deviceId }) {
  const roleName = `role_${deviceId}`
  await _dynsecCommand('deleteClient', { username: mqttUser }).catch(() => {})
  await _dynsecCommand('deleteRole',   { rolename: roleName }).catch(() => {})
  console.log(`[local] dynsec deleted: user=${mqttUser}`)
}

// ── Самовосстановление ACL/пароля для уже зарегистрированных устройств ──
async function ensureDeviceAccess({ deviceId, mqttUser, mqttPass, mqttTopic, syncPassword = false  }) {
  const roleName = `role_${deviceId}`

// Пароль меняем только в режимах миграции/ремонта, иначе активный ESP получает disconnect.
  if (syncPassword) {
    await _dynsecCommand('setClientPassword', { username: mqttUser, password: mqttPass })
      .catch(() => {})
  }
  await _dynsecCommand('createRole', { rolename: roleName }).catch(() => {})

  const acls = [
    { acltype: 'subscribePattern',  topic: `$devices/${mqttUser}/commands`, allow: true },
    { acltype: 'publishClientReceive', topic: `$devices/${mqttUser}/commands`, allow: true },
    { acltype: 'publishClientSend', topic: `$devices/${mqttUser}/events`,   allow: true },
    // { acltype: 'subscribePattern',  topic: `relay/${mqttTopic}/cmd`,         allow: true },
    // { acltype: 'publishClientReceive', topic: `relay/${mqttTopic}/cmd`,         allow: true },
    // { acltype: 'publishClientSend', topic: `relay/${mqttTopic}/status`,      allow: true },
    // { acltype: 'publishClientSend', topic: `sys/devices/${deviceId}/status`, allow: true },
  ]
  for (const acl of acls) {
    await _dynsecCommand('addRoleACL', { rolename: roleName, ...acl })
      .catch(err => console.warn(`[local] ensure ACL skipped ${acl.acltype} ${acl.topic}: ${err.message}`))
  }

  await _dynsecCommand('addClientRole', {
    username: mqttUser,
    rolename: roleName,
    priority: -1,
  }).catch(err => console.warn(`[local] ensure addClientRole skipped for ${mqttUser}: ${err.message}`))
}

async function repairExistingDevices(db) {
  const rows = await db`
    SELECT d.device_id, d.mqtt_user, d.mqtt_password, g.mqtt_topic
    FROM devices d
    JOIN groups g ON g.id = d.group_id
    WHERE d.mqtt_user IS NOT NULL AND d.mqtt_password IS NOT NULL
  `
  for (const row of rows) {
    await ensureDeviceAccess({
      deviceId: row.device_id,
      mqttUser: row.mqtt_user,
      mqttPass: row.mqtt_password,
      mqttTopic: row.mqtt_topic,
      syncPassword: true,
    })
  }
  console.log(`[local] ACL repair completed for ${rows.length} device(s)`)
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
  ensureDeviceAccess,
  repairExistingDevices,
  getEspConfig,
}
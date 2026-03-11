'use strict'

const CONTROL_TOPIC  = '$CONTROL/dynamic-security/v1'
const RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response'
const TIMEOUT_MS     = 5000

let _client = null
function setClient(c) { _client = c }

function dynsecCommand(command, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!_client) return reject(new Error('MQTT client not ready'))

    const msg   = JSON.stringify({ commands: [{ command, ...payload }] })
    const timer = setTimeout(() => {
      _client.removeListener('message', handler)
      reject(new Error(`dynsec timeout: ${command}`))
    }, TIMEOUT_MS)

    function handler(topic, buf) {
      if (topic !== RESPONSE_TOPIC) return
      let resp
      try { resp = JSON.parse(buf.toString()) } catch { return }
      const r = resp.responses?.[0]
      if (!r || r.command !== command) return
      clearTimeout(timer)
      _client.removeListener('message', handler)
      if (r.error && r.error !== 'Client already exists' && r.error !== 'Role already exists') {
        reject(new Error(`dynsec ${command}: ${r.error}`))
      } else {
        resolve(r.data || {})
      }
    }

    _client.subscribe(RESPONSE_TOPIC, () => {
      _client.on('message', handler)
      _client.publish(CONTROL_TOPIC, msg, { qos: 1 })
    })
  })
}

// ── Бэкенд ────────────────────────────────────────────────────
// Вызывается при старте — бэкенд читает события всех устройств
// и публикует команды на устройства
async function ensureBackendRole(mqttUser) {
  const rolename = 'role_backend'
  // Создаём роль если не существует (ошибка "already exists" игнорируется)
  try {
    await dynsecCommand('createRole', {
      rolename,
      acls: [
        { acltype: 'subscribePattern',     topic: '$devices/+/events',   allow: true },
        { acltype: 'publishClientReceive', topic: '$devices/+/events',   allow: true },
        { acltype: 'publishClientSend',    topic: '$devices/+/commands', allow: true },
      ],
    })
  } catch (e) {
    // "Role already exists" — нормально, роль уже есть
    if (!e.message.includes('already exists')) throw e
  }
  try { await dynsecCommand('addClientRole', { username: mqttUser, rolename, priority: 1 }) } catch {}
  console.log(`[dynsec] Backend role ensured for ${mqttUser}`)
}

// ── ESP устройство ────────────────────────────────────────────
// Устройство получает команды и публикует события только по своему MAC
async function createDeviceClient(mqttUser, mqttPass, macClean) {
  try { await dynsecCommand('deleteClient', { username: mqttUser }) } catch {}

  await dynsecCommand('createClient', {
    username: mqttUser,
    password: mqttPass,
    textname: `ESP ${macClean}`,
    roles:    [],
  })

  const rolename = `role_esp_${macClean}`
  try { await dynsecCommand('deleteRole', { rolename }) } catch {}

  await dynsecCommand('createRole', {
    rolename,
    acls: [
      // Получать команды
      { acltype: 'subscribeLiteral',     topic: `$devices/${macClean}/commands`, allow: true },
      { acltype: 'publishClientReceive', topic: `$devices/${macClean}/commands`, allow: true },
      // Публиковать события (статусы, LWT)
      { acltype: 'publishClientSend',    topic: `$devices/${macClean}/events`,   allow: true },
    ],
  })

  await dynsecCommand('addClientRole', { username: mqttUser, rolename, priority: -1 })
  console.log(`[dynsec] Device client created: ${mqttUser}`)
}

// ── Пользователь PWA ──────────────────────────────────────────
// Пользователь может только публиковать команды на устройства своих групп.
// deviceIds — массив MAC устройств привязанных к группам пользователя.
async function createUserClient(mqttUser, mqttPass, deviceIds = []) {
  // Удалить старого клиента если есть
  try { await dynsecCommand('deleteClient', { username: mqttUser }) } catch {}

  await dynsecCommand('createClient', {
    username: mqttUser,
    password: mqttPass,
    textname: `User ${mqttUser}`,
    roles:    [],
  })

  const rolename = `role_user_${mqttUser}`
  try { await dynsecCommand('deleteRole', { rolename }) } catch {}

  // ACL — только publishClientSend на команды своих устройств
  const acls = deviceIds.map(mac => ({
    acltype: 'publishClientSend',
    topic:   `$devices/${mac}/commands`,
    allow:   true,
  }))

  if (acls.length > 0) {
    await dynsecCommand('createRole', { rolename, acls })
    await dynsecCommand('addClientRole', { username: mqttUser, rolename, priority: -1 })
  } else {
    // Нет устройств — создать роль без ACL (пользователь не сможет ничего)
    await dynsecCommand('createRole', { rolename, acls: [] })
    await dynsecCommand('addClientRole', { username: mqttUser, rolename, priority: -1 })
  }

  console.log(`[dynsec] User client created: ${mqttUser} (${deviceIds.length} devices)`)
}

// ── Обновить устройства пользователя ─────────────────────────
// Вызывается когда пользователя добавляют/удаляют из группы
async function updateUserDevices(mqttUser, deviceIds = []) {
  const rolename = `role_user_${mqttUser}`
  try { await dynsecCommand('deleteRole', { rolename }) } catch {}

  const acls = deviceIds.map(mac => ({
    acltype: 'publishClientSend',
    topic:   `$devices/${mac}/commands`,
    allow:   true,
  }))

  await dynsecCommand('createRole', { rolename, acls })
  try { await dynsecCommand('addClientRole', { username: mqttUser, rolename, priority: -1 }) } catch {}
  console.log(`[dynsec] User devices updated: ${mqttUser} (${deviceIds.length} devices)`)
}

async function deleteDeviceClient(mqttUser, macClean) {
  try { await dynsecCommand('removeClientRole', { username: mqttUser, rolename: `role_esp_${macClean}` }) } catch {}
  try { await dynsecCommand('deleteRole',        { rolename: `role_esp_${macClean}` }) } catch {}
  try { await dynsecCommand('deleteClient',      { username: mqttUser }) } catch {}
}

async function deleteUserClient(mqttUser) {
  const rolename = `role_user_${mqttUser}`
  try { await dynsecCommand('removeClientRole', { username: mqttUser, rolename }) } catch {}
  try { await dynsecCommand('deleteRole',        { rolename }) } catch {}
  try { await dynsecCommand('deleteClient',      { username: mqttUser }) } catch {}
}

module.exports = {
  setClient,
  ensureBackendRole,
  createDeviceClient,
  deleteDeviceClient,
  createUserClient,
  updateUserDevices,
  deleteUserClient,
}
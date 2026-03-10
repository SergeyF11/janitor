'use strict'

const CONTROL_TOPIC  = '$CONTROL/dynamic-security/v1'
const RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response'
const TIMEOUT_MS     = 5000

// Клиент передаётся снаружи — нет циклической зависимости
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

async function ensureBackendRole(mqttUser) {
  const rolename = 'role_backend'
  try {
    await dynsecCommand('createRole', {
      rolename,
      acls: [
        { acltype: 'publishClientSend',    topic: 'relay/+/cmd',          allow: true },
        { acltype: 'subscribeLiteral',     topic: 'relay/+/status',       allow: true },
        { acltype: 'publishClientReceive', topic: 'relay/+/status',       allow: true },
        { acltype: 'subscribeLiteral',     topic: 'sys/devices/+/status', allow: true },
        { acltype: 'publishClientReceive', topic: 'sys/devices/+/status', allow: true },
      ],
    })
  } catch {}
  try { await dynsecCommand('addClientRole', { username: mqttUser, rolename, priority: 1 }) } catch {}
  console.log(`[dynsec] Backend role ensured for ${mqttUser}`)
}

async function createDeviceClient(mqttUser, mqttPass, macClean, mqttTopic) {
  try { await dynsecCommand('deleteClient', { username: mqttUser }) } catch {}

  await dynsecCommand('createClient', {
    username: mqttUser,
    password: mqttPass,
    textname: `ESP ${macClean}`,
    roles:    [],
  })

  const rolename = `role_esp_${macClean}`
  try {
    await dynsecCommand('createRole', {
      rolename,
      acls: [
        { acltype: 'subscribeLiteral',     topic: `relay/${mqttTopic}/cmd`,         allow: true },
        { acltype: 'publishClientReceive', topic: `relay/${mqttTopic}/cmd`,         allow: true },
        { acltype: 'publishClientSend',    topic: `relay/${mqttTopic}/status`,      allow: true },
        { acltype: 'publishClientSend',    topic: `sys/devices/${macClean}/status`, allow: true },
      ],
    })
  } catch {}

  await dynsecCommand('addClientRole', { username: mqttUser, rolename, priority: -1 })
  console.log(`[dynsec] Device client created: ${mqttUser}`)
}

async function deleteDeviceClient(mqttUser, macClean) {
  try { await dynsecCommand('removeClientRole', { username: mqttUser, rolename: `role_esp_${macClean}` }) } catch {}
  try { await dynsecCommand('deleteRole',        { rolename: `role_esp_${macClean}` }) } catch {}
  try { await dynsecCommand('deleteClient',      { username: mqttUser }) } catch {}
}

module.exports = { setClient, createDeviceClient, deleteDeviceClient, ensureBackendRole }
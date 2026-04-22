'use strict'
const mqtt      = require('mqtt')
const { getDb } = require('../db/connection')
const provider  = require('./provider')

let client = null

// ── Реестр ожидающих ответов от ESP ──────────────────────────
// Используется для get_phone, backup_db — ответ приходит через MQTT
// key: `${deviceId}:${type}`, value: { resolve, reject, timer }
const _pending = new Map()

function registerPending(deviceId, type, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const key   = `${deviceId}:${type}`
    const timer = setTimeout(() => {
      _pending.delete(key)
      reject(new Error(`timeout waiting for ${type} from ${deviceId}`))
    }, timeoutMs)
    _pending.set(key, { resolve, reject, timer })
  })
}

function resolvePending(deviceId, type, data) {
  const key = `${deviceId}:${type}`
  const p   = _pending.get(key)
  if (!p) return false
  clearTimeout(p.timer)
  _pending.delete(key)
  p.resolve(data)
  return true
}

// ── Публикация команды на устройство ─────────────────────────
function publishCommand(mqttUser, payload) {
  if (!client || !client.connected) return false
  // DEVICE_CMD_TMPL = "$devices/%s/commands"
  const topic = `$devices/${mqttUser}/commands`
  client.publish(topic, JSON.stringify(payload), { qos: 1 })
  console.log(`[mqtt] → cmd to ${mqttUser}: ${JSON.stringify(payload)}`)
  return true
}

// ── Широковещательные функции (заполняются из ws.js) ─────────
let _broadcastRelayStatus  = () => {}
let _broadcastDeviceStatus = () => {}
let _broadcastGsmEvent     = () => {}

async function connect() {
  const { url, options } = provider.getConnectOptions()

  client = mqtt.connect(url, options)

  client.on('connect', () => {
    console.log(`[mqtt] Connected to ${url}`)
    const topics = provider.topicsToSubscribe()
    client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) console.error('[mqtt] subscribe error:', err.message)
      else console.log('[mqtt] Subscribed:', topics)
    })
  })

  client.on('message', async (topic, payload) => {
    try { await handleMessage(topic, payload.toString()) }
    catch (err) { console.error('[mqtt] handler error:', err.message) }
  })

  client.on('error',      err => console.error('[mqtt] error:', err.message))
  client.on('disconnect', ()  => console.log('[mqtt] Disconnected'))

  // Heartbeat fallback — только для Яндекса (LWT не работает)
  if (!provider.supportsLWT) {
    const TIMEOUT = provider.HEARTBEAT_TIMEOUT_MS || 3 * 60 * 1000
    setInterval(() => checkHeartbeatTimeouts(TIMEOUT), 60 * 1000)
    console.log(`[mqtt] Heartbeat timeout checker started (${TIMEOUT / 1000}s)`)
  }

  return client
}

async function handleMessage(topic, payload) {
  const db = getDb()
  console.log(`[mqtt] message: ${topic} ${payload.substring(0, 120)}`)

  // ── Стандартные события устройства (online/relay) ─────────
  const parsed = await provider.parseMessage(topic, payload, db)
  if (parsed) {
    const { deviceId, online, fw, relays } = parsed

    if (online === true) {
      await db`
        UPDATE devices
        SET is_online  = true,
            last_seen  = NOW(),
            fw_version = COALESCE(${fw}, fw_version)
        WHERE device_id = ${deviceId}
      `
      broadcastDeviceStatus(deviceId, true)
    } else if (online === false) {
      await db`UPDATE devices SET is_online = false WHERE device_id = ${deviceId}`
      broadcastDeviceStatus(deviceId, false)
    } else if (fw) {
      await db`
        UPDATE devices SET last_seen = NOW(),
          fw_version = COALESCE(${fw}, fw_version)
        WHERE device_id = ${deviceId}
      `
      broadcastDeviceStatus(deviceId, true)
    }

    if (relays && Array.isArray(relays)) {
      if (online == null)
        await db`UPDATE devices SET last_seen = NOW() WHERE device_id = ${deviceId}`
      for (const r of relays) {
        if (r.name) {
          const [relay] = await db`
            UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
            WHERE device_id = ${deviceId} AND name = ${r.name}
            RETURNING id
          `
          if (relay) broadcastRelayStatus(relay.id, r.state)
        } else if (r.index != null) {
          const [relay] = await db`
            UPDATE relays SET last_state = ${r.state}, last_state_at = NOW()
            WHERE device_id = ${deviceId} AND relay_index = ${r.index}
            RETURNING id
          `
          if (relay) broadcastRelayStatus(relay.id, r.state)
        }
      }
    }

    // ── GSM-поля в online-сообщении ─────────────────────────
    // ESP включает unread_sms в publishOnline
    if (online === true) {
      let data = null
      try { data = JSON.parse(payload) } catch {}
      if (data?.unread_sms != null) {
        await _handleGsmUnreadUpdate(deviceId, data.unread_sms, db)
      }
    }
    return
  }

  // ── GSM-события (тип определяется по полю "type") ─────────
  let data = null
  try { data = JSON.parse(payload) } catch { return }
  if (!data?.type) return

  // Найти device_id по mqtt_user из топика
  const mqttUserMatch = topic.match(/^\$devices\/([^/]+)\//)
  if (!mqttUserMatch) return
  const mqttUser = mqttUserMatch[1]
  const [dev] = await db`SELECT device_id, group_id FROM devices WHERE mqtt_user = ${mqttUser}`
  if (!dev) return

  await _handleGsmMessage(dev.device_id, dev.group_id, data, db)
}

// ── Обработка GSM-событий ─────────────────────────────────────
async function _handleGsmMessage(deviceId, groupId, data, db) {
  switch (data.type) {

  // Авторизованное событие (звонок/SMS) — пишем в журнал группы
  case 'gsm_event': {
    const { source, idx, action, relay_mask, number, text, unread_sms } = data

    let userId = null
    let actorLogin = null

    if (idx) {
      // Найти user_id по idx из gsm_phone_idx
      const [row] = await db`
        SELECT gpi.user_id, u.login
        FROM gsm_phone_idx gpi
        JOIN users u ON u.id = gpi.user_id
        WHERE gpi.id = ${idx} AND gpi.device_id = ${deviceId}
      `
      if (row) { userId = row.user_id; actorLogin = row.login }
    }

    await db`
      INSERT INTO event_log
        (action, target_type, target_id, group_id, actor_id, actor_login, payload)
      VALUES (
        ${action || 'gsm_event'},
        'device', ${deviceId}, ${groupId},
        ${userId}, ${actorLogin},
        ${JSON.stringify({
          source,
          relay_mask,
          ...(number ? { number } : {}),
          ...(text   ? { text }   : {}),
        })}
      )
    `

    // Обновить счётчик непрочитанных SMS если пришёл
    if (unread_sms != null)
      await _handleGsmUnreadUpdate(deviceId, unread_sms, db)

    // Уведомить WebSocket-клиентов
    broadcastGsmEvent(groupId, { source, action, idx, relay_mask, number })
    break
  }

  // Статус GSM модема
  case 'gsm_status': {
    await db`
      UPDATE devices
      SET gsm_status = ${JSON.stringify(data)}, last_seen = NOW()
      WHERE device_id = ${deviceId}
    `
    broadcastGsmEvent(groupId, { type: 'gsm_status', ...data })
    break
  }

  // Ответ на get_phone — resolve pending
  case 'phone_response': {
    resolvePending(deviceId, 'phone_response', data)
    break
  }

  // Журнал SMS — resolve pending
  case 'sms_journal': {
    resolvePending(deviceId, 'sms_journal', data)
    break
  }

  // Чанк бэкапа — накапливаем
  case 'backup_db': {
    await _handleBackupChunk(deviceId, data)
    break
  }

  // Результат команды (set_phone, del_phone, etc.)
  case 'cmd_result': {
    const action = data.action || 'cmd_result'
    resolvePending(deviceId, action, data)
    console.log(`[gsm] cmd_result: ${action} ok=${data.ok}`)
    break
  }

  // Инициализация GSM модема при старте
  case 'gsm_init': {
    await db`
      UPDATE devices
      SET gsm_status = ${JSON.stringify(data)}, last_seen = NOW()
      WHERE device_id = ${deviceId}
    `
    break
  }

  // Компактификация БД
  case 'db_compaction': {
    console.log(`[gsm] compaction on ${deviceId}: ok=${data.ok}`)
    break
  }

  default:
    console.log(`[gsm] unknown event type: ${data.type}`)
  }
}

// ── Счётчик непрочитанных SMS в devices ───────────────────────
async function _handleGsmUnreadUpdate(deviceId, count, db) {
  try {
    await db`
      UPDATE devices SET gsm_unread_sms = ${count} WHERE device_id = ${deviceId}
    `
  } catch {} // колонка может не существовать — не критично
}

// ── Накопление чанков бэкапа ──────────────────────────────────
const _backupChunks = new Map()  // deviceId → { chunks:[], total }

async function _handleBackupChunk(deviceId, data) {
  if (!data.ok && data.seq == null) {
    resolvePending(deviceId, 'backup_db', { ok: false })
    return
  }

  if (!_backupChunks.has(deviceId))
    _backupChunks.set(deviceId, { chunks: [], total: data.total })

  const acc = _backupChunks.get(deviceId)
  acc.chunks[data.seq] = data.data || ''

  const received = acc.chunks.filter(Boolean).length
  if (received < acc.total) return  // ждём остальные

  // Все чанки получены
  const b64 = acc.chunks.join('')
  _backupChunks.delete(deviceId)
  resolvePending(deviceId, 'backup_db', { ok: true, data: b64 })
}

// Heartbeat timeout — помечает устройства оффлайн если нет сигнала
async function checkHeartbeatTimeouts(timeoutMs) {
  const db = getDb()
  try {
    const stale = await db`
      UPDATE devices
      SET is_online = false
      WHERE is_online = true
        AND last_seen < NOW() - (${timeoutMs} || ' milliseconds')::interval
      RETURNING device_id
    `
    for (const d of stale) {
      console.log(`[mqtt] heartbeat timeout: ${d.device_id} -> offline`)
      broadcastDeviceStatus(d.device_id, false)
    }
  } catch (err) {
    console.error('[mqtt] heartbeat check error:', err.message)
  }
}

function broadcastRelayStatus(id, state)         { _broadcastRelayStatus(id, state) }
function broadcastDeviceStatus(deviceId, online)  { _broadcastDeviceStatus(deviceId, online) }
function broadcastGsmEvent(groupId, data)         { _broadcastGsmEvent(groupId, data) }

// Обратная совместимость: ws.js вызывает с 2 аргументами
// gsmFn опционален — добавляется из ws.js отдельным вызовом
function setBroadcasters(relayFn, deviceFn, gsmFn) {
  _broadcastRelayStatus  = relayFn  || (() => {})
  _broadcastDeviceStatus = deviceFn || (() => {})
  if (gsmFn) _broadcastGsmEvent = gsmFn
}

// Отдельный метод для регистрации GSM broadcaster из ws.js
function setGsmBroadcaster(gsmFn) {
  _broadcastGsmEvent = gsmFn || (() => {})
}

function getClient() { return client }

module.exports = {
  connect,
  getClient,
  setBroadcasters,
  setGsmBroadcaster,
  publishCommand,
  registerPending,
}
'use strict'
const { getDb } = require('./db/connection')
const { setBroadcasters } = require('./mqtt/client')

// Хранилище подключённых клиентов: userId → Set<WebSocket>
const clients = new Map()

async function wsPlugin(app) {

  // WS /janitor/api/ws?token=<accessToken>
  app.get('/ws', { websocket: true }, async (socket, req) => {
    let userId = null
    let userGroups = []

    // Авторизация по токену из query string
    try {
      const token = req.query?.token
      if (!token) throw new Error('no token')

      const payload = app.jwt.verify(token)
      userId = payload.sub

      // Проверить token_version
      const db = getDb()
      const [user] = await db`
        SELECT token_version, is_active FROM users WHERE id = ${userId}
      `
      if (!user || !user.is_active || user.token_version !== payload.tv) {
        throw new Error('invalid token')
      }

      // Получить группы пользователя для фильтрации сообщений
      const groups = await db`
        SELECT g.mqtt_topic, g.id FROM user_groups ug
        JOIN groups g ON g.id = ug.group_id
        WHERE ug.user_id = ${userId} AND g.status = 'active'
      `
      userGroups = groups

    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', error: 'unauthorized' }))
      socket.close()
      return
    }

    // Зарегистрировать клиента
    if (!clients.has(userId)) clients.set(userId, new Set())
    clients.get(userId).add(socket)

    console.log(`[ws] User ${userId} connected. Total: ${countClients()}`)

    // Ping каждые 30 секунд чтобы не закрывало соединение
    const pingInterval = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000)

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw)
        if (msg.type === 'pong') return  // клиент ответил на ping
      } catch {}
    })

    socket.on('close', () => {
      clients.get(userId)?.delete(socket)
      if (clients.get(userId)?.size === 0) clients.delete(userId)
      clearInterval(pingInterval)
      console.log(`[ws] User ${userId} disconnected. Total: ${countClients()}`)
    })

    socket.on('error', (err) => {
      console.error(`[ws] Socket error for ${userId}:`, err.message)
    })

    // Отправить текущие состояния групп при подключении
    try {
      const db = getDb()
      for (const group of userGroups) {
        const [last] = await db`
          SELECT payload->>'state' as state, ts
          FROM event_log
          WHERE group_id = ${group.id} AND action = 'relay_trigger'
          ORDER BY ts DESC LIMIT 1
        `
        if (last) {
          socket.send(JSON.stringify({
            type:  'relay_status',
            topic: group.mqtt_topic,
            state: last.state,
            ts:    last.ts,
          }))
        }
      }
    } catch {}
  })

  // ── Зарегистрировать broadcasters в MQTT client ───────────────
  setBroadcasters(
    // relayFn: topic → всем у кого есть эта группа
    async (mqttTopic, data) => {
      try {
        const db = getDb()
        const users = await db`
          SELECT ug.user_id FROM user_groups ug
          JOIN groups g ON g.id = ug.group_id
          WHERE g.mqtt_topic = ${mqttTopic}
        `
        const msg = JSON.stringify({
          type:  'relay_status',
          topic: mqttTopic,
          state: data.state,
          ts:    new Date().toISOString(),
        })
        for (const { user_id } of users) {
          sendToUser(user_id, msg)
        }
      } catch {}
    },

    // deviceFn: deviceId, online → всем админам этого устройства
    async (deviceId, online) => {
      try {
        const db = getDb()
        const admins = await db`
          SELECT DISTINCT ug.user_id FROM device_groups dg
          JOIN user_groups ug ON ug.group_id = dg.group_id AND ug.role = 'admin'
          WHERE dg.device_id = ${deviceId}
        `
        const msg = JSON.stringify({
          type:      'device_status',
          device_id: deviceId,
          online,
          ts:        new Date().toISOString(),
        })
        for (const { user_id } of admins) {
          sendToUser(user_id, msg)
        }
      } catch {}
    }
  )
}

function sendToUser(userId, msg) {
  const sockets = clients.get(userId)
  if (!sockets) return
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      try { socket.send(msg) } catch {}
    }
  }
}

function countClients() {
  let total = 0
  for (const sockets of clients.values()) total += sockets.size
  return total
}

module.exports = wsPlugin
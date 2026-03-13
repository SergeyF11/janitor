'use strict'
const { getDb } = require('./db/connection')
const { setBroadcasters } = require('./mqtt/client')

const clients = new Map()  // wsId → { ws, userId, groupIds: Set }
let _nextId = 1

async function wsRoutes(app) {

  // Регистрируем broadcast-функции в MQTT клиенте
  setBroadcasters(
    // relayFn(relayId, state) — обновление реле
    async (relayId, state) => {
      // Найти group_id для этого реле
      const db = getDb()
      const [row] = await db`
        SELECT d.group_id FROM relays r
        JOIN devices d ON d.device_id = r.device_id
        WHERE r.id = ${relayId}
      `
      if (!row) return
      broadcastToGroup(row.group_id, { type: 'relay_status', relay_id: relayId, state })
    },
    // deviceFn(deviceId, online) — статус устройства
    async (deviceId, online) => {
      const db = getDb()
      const [row] = await db`SELECT group_id FROM devices WHERE device_id = ${deviceId}`
      if (!row?.group_id) return
      broadcastToGroup(row.group_id, { type: 'device_status', device_id: deviceId, online })
    }
  )

  // WebSocket endpoint: /janitor/api/ws?token=<accessToken>
  app.get('/ws', { websocket: true }, async (socket, req) => {
    // Аутентификация через query param токена
    let userId
    try {
      const token = req.query.token
      if (!token) { socket.close(4001, 'unauthorized'); return }
      const payload = app.jwt.verify(token)
      userId = payload.sub
    } catch {
      socket.close(4001, 'unauthorized')
      return
    }

    // Загрузить группы пользователя
    const db       = getDb()
    const groupRows = await db`SELECT group_id FROM user_groups WHERE user_id = ${userId}`
    const groupIds  = new Set(groupRows.map(r => r.group_id))

    const wsId = _nextId++
    clients.set(wsId, { socket, userId, groupIds })

    // Пинг каждые 30 сек чтобы не закрыли idle соединение
    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping' }))
    }, 30000)

    socket.on('close', () => {
      clearInterval(pingInterval)
      clients.delete(wsId)
    })

    socket.on('error', () => {
      clearInterval(pingInterval)
      clients.delete(wsId)
    })
  })
}

function broadcastToGroup(groupId, msg) {
  const payload = JSON.stringify(msg)
  for (const [, client] of clients) {
    if (client.groupIds.has(groupId) && client.socket.readyState === 1) {
      try { client.socket.send(payload) } catch {}
    }
  }
}

module.exports = wsRoutes

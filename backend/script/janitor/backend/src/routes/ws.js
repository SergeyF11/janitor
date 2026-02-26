'use strict'

const { subscribeStatus } = require('../mqtt/client')
const { getDb } = require('../db/connection')

async function wsRoutes(app) {

  // WS /ws — подписка на статусы реле пользователя в реальном времени
  app.get('/ws', { websocket: true }, async (socket, req) => {
    // Проверить JWT из query параметра (WS не поддерживает заголовки)
    const token = req.query?.token
    if (!token) {
      socket.close(1008, 'Unauthorized')
      return
    }

    let user
    try {
      user = app.jwt.verify(token)
    } catch (e) {
      socket.close(1008, 'Invalid token')
      return
    }

    // Получить группы пользователя
    const db = getDb()
    const groups = await db`
      SELECT g.mqtt_topic FROM groups g
      JOIN user_groups ug ON ug.group_id = g.id
      WHERE ug.user_id = ${user.id}
    `

    // Подписаться на статусы всех групп пользователя
    const unsubscribers = groups.map(g =>
      subscribeStatus(g.mqtt_topic, (data) => {
        if (socket.readyState === 1) { // OPEN
          socket.send(JSON.stringify({
            type: 'relay_status',
            topic: g.mqtt_topic,
            ...data
          }))
        }
      })
    )

    socket.send(JSON.stringify({ type: 'connected', groups: groups.length }))

    socket.on('close', () => {
      unsubscribers.forEach(unsub => unsub())
    })
  })
}

module.exports = wsRoutes

'use strict'

const { getDb } = require('../db/connection')
const { publishTrigger } = require('../mqtt/client')

async function userRoutes(app) {

  // GET /api/user/groups — мои группы (кнопки на главном экране)
  app.get('/user/groups', {
    onRequest: [app.authenticate]
  }, async (req, reply) => {
    const db = getDb()
    const groups = await db`
      SELECT g.id, g.name, g.mqtt_topic, g.relay_duration_ms, g.relay_state,
             ug.role
      FROM groups g
      JOIN user_groups ug ON ug.group_id = g.id
      WHERE ug.user_id = ${req.user.id}
      ORDER BY g.name
    `
    return groups
  })

  // POST /api/user/groups/:id/trigger — нажатие кнопки
  app.post('/user/groups/:id/trigger', {
    onRequest: [app.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const groupId = req.params.id

    // Проверить права пользователя на эту группу
    const [membership] = await db`
      SELECT ug.role FROM user_groups ug
      WHERE ug.user_id = ${req.user.id} AND ug.group_id = ${groupId}
    `
    if (!membership) {
      return reply.code(403).send({ error: 'Access denied' })
    }

    // Получить параметры группы
    const [group] = await db`
      SELECT id, mqtt_topic, relay_duration_ms, relay_state
      FROM groups WHERE id = ${groupId}
    `
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' })
    }

    // Опубликовать команду в MQTT
    await publishTrigger(group.mqtt_topic, req.user.id, group.relay_duration_ms)

    // Для триггерного режима (duration=0) сразу обновить состояние в БД
    let newState = null
    if (group.relay_duration_ms === 0) {
      newState = !group.relay_state
      await db`
        UPDATE groups SET relay_state = ${newState}, updated_at = NOW()
        WHERE id = ${groupId}
      `
    }

    // Записать в журнал
    const action = group.relay_duration_ms > 0
      ? `pulse_${group.relay_duration_ms}ms`
      : `toggle_${newState ? 'on' : 'off'}`

    await db`
      INSERT INTO event_log (group_id, user_id, source, action)
      VALUES (${groupId}, ${req.user.id}, 'pwa', ${action})
    `

    return {
      ok: true,
      mode: group.relay_duration_ms > 0 ? 'pulse' : 'toggle',
      state: newState,
      duration: group.relay_duration_ms
    }
  })
}

module.exports = userRoutes

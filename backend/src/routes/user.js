'use strict'
const { getDb } = require('../db/connection')
const { authenticate } = require('../services/auth.service')

async function userRoutes(app) {

  // GET /api/user/me — профиль с ID (пользователь видит свой ID для передачи администратору)
  app.get('/user/me', {
    onRequest: [authenticate]
  }, async (req) => {
    const db = getDb()
    const [user] = await db`
      SELECT id, login, display_name, phone, email,
             role, single_session, must_change_password, created_at
      FROM users WHERE id = ${req.user.id}
    `
    return user
  })

  // GET /api/user/groups — группы и реле текущего пользователя
  app.get('/user/groups', {
    onRequest: [authenticate]
  }, async (req) => {
    const db = getDb()
    return db`
      SELECT
        g.id, g.name, g.mqtt_topic, g.relay_duration_ms,
        g.status, g.expires_at, g.grace_until,
        ug.description, ug.role,
        -- Статус устройства группы
        (
          SELECT CASE WHEN MAX(d.last_seen) > NOW() - INTERVAL '2 minutes'
                      THEN true ELSE false END
          FROM device_groups dg
          JOIN devices d ON d.device_id = dg.device_id
          WHERE dg.group_id = g.id
        ) as device_online,
        -- Последнее состояние реле (для триггерного режима)
        (
          SELECT el.payload->>'state'
          FROM event_log el
          WHERE el.group_id = g.id AND el.action = 'relay_trigger'
          ORDER BY el.ts DESC LIMIT 1
        ) as relay_state
      FROM groups g
      JOIN user_groups ug ON ug.group_id = g.id
      WHERE ug.user_id = ${req.user.id}
        AND g.status = 'active'
        AND (g.expires_at IS NULL OR g.expires_at > NOW() OR g.grace_until > NOW())
      ORDER BY g.name
    `
  })

  // POST /api/user/groups/:groupId/trigger — нажать кнопку (управление реле)
  app.post('/user/groups/:groupId/trigger', {
    onRequest: [authenticate]
  }, async (req, reply) => {
    const db = getDb()
    const groupId = req.params.groupId

    // Проверить доступ пользователя к группе
    const [membership] = await db`
      SELECT ug.role FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id
      WHERE ug.user_id = ${req.user.id}
        AND ug.group_id = ${groupId}
        AND g.status = 'active'
        AND (g.expires_at IS NULL OR g.expires_at > NOW() OR g.grace_until > NOW())
    `
    if (!membership) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const [group] = await db`
      SELECT id, mqtt_topic, relay_duration_ms FROM groups WHERE id = ${groupId}
    `
    if (!group) return reply.code(404).send({ error: 'not_found' })

    // Определить действие в зависимости от режима реле
    let action, newState
    if (group.relay_duration_ms === 0) {
      // Триггерный режим — переключить состояние
      const [last] = await db`
        SELECT payload->>'state' as state
        FROM event_log
        WHERE group_id = ${groupId} AND action = 'relay_trigger'
        ORDER BY ts DESC LIMIT 1
      `
      newState = last?.state === 'on' ? 'off' : 'on'
      action   = { action: 'toggle', state: newState }
    } else {
      // Импульсный режим
      newState = 'pulse'
      action   = { action: 'pulse', duration: group.relay_duration_ms }
    }

    // Опубликовать команду в MQTT
    const topic = `relay/${group.mqtt_topic}/trigger`
    try {
      const mqttClient = app.mqtt  // подключается в app.js
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(topic, JSON.stringify(action), { qos: 1 })
      }
    } catch (err) {
      console.error('[mqtt] publish error:', err.message)
    }

    // Логировать событие
    await db`
      INSERT INTO event_log (actor_id, actor_login, action, group_id, payload, ip)
      VALUES (${req.user.id}, ${req.user.login}, 'relay_trigger', ${groupId},
              ${JSON.stringify({ ...action, state: newState, topic })},
              ${req.ip})
    `

    return { ok: true, state: newState, action }
  })
}

module.exports = userRoutes
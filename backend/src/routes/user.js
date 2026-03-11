'use strict'
const { getDb } = require('../db/connection')
const { authenticate } = require('../services/auth.service')

async function userRoutes(app) {

  // GET /api/user/me — профиль с ID
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

  // GET /api/user/groups — группы текущего пользователя
  app.get('/user/groups', {
    onRequest: [authenticate]
  }, async (req) => {
    const db = getDb()
    return db`
      SELECT
        g.id, g.name, g.mqtt_topic, g.relay_duration_ms,
        g.status, g.expires_at, g.grace_until,
        ug.description, ug.role,
        -- device_id устройства группы (для MQTT команд из PWA)
        (
          SELECT dg.device_id
          FROM device_groups dg
          WHERE dg.group_id = g.id
          LIMIT 1
        ) as device_id,
        -- Статус устройства группы
        (
          SELECT COALESCE(bool_or(d.is_online), false)
          FROM device_groups dg
          JOIN devices d ON d.device_id = dg.device_id
          WHERE dg.group_id = g.id
        ) as device_online,
        -- Последнее состояние реле
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

  // POST /api/user/groups/:groupId/trigger — нажать кнопку
  app.post('/user/groups/:groupId/trigger', {
    onRequest: [authenticate]
  }, async (req, reply) => {
    const db      = getDb()
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
    if (!membership) return reply.code(403).send({ error: 'forbidden' })

    // Найти группу и устройство
    const [group] = await db`
      SELECT g.id, g.name, g.mqtt_topic, g.relay_duration_ms,
             dg.device_id, dg.relay_index
      FROM groups g
      LEFT JOIN device_groups dg ON dg.group_id = g.id
      WHERE g.id = ${groupId}
      LIMIT 1
    `
    if (!group) return reply.code(404).send({ error: 'not_found' })
    if (!group.device_id) return reply.code(503).send({ error: 'no_device' })

    // Определить действие
    let action, newState
    if (group.relay_duration_ms === 0) {
      const [last] = await db`
        SELECT payload->>'state' as state
        FROM event_log
        WHERE group_id = ${groupId} AND action = 'relay_trigger'
        ORDER BY ts DESC LIMIT 1
      `
      newState = last?.state === 'on' ? 'off' : 'on'
      action   = 'toggle'
    } else {
      newState = 'pulse'
      action   = 'pulse'
    }

    // Команда на устройство: {group, action, duration?}
    const cmd = {
      group:  group.name,
      action,
      ...(action === 'pulse' ? { duration: group.relay_duration_ms } : {}),
    }

    const topic = `$devices/${group.device_id}/commands`
    try {
      const mqttClient = app.mqtt
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(topic, JSON.stringify(cmd), { qos: 1 })
      }
    } catch (err) {
      console.error('[mqtt] publish error:', err.message)
    }

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, group_id, payload, ip)
      VALUES (${req.user.id}, ${req.user.login}, 'relay_trigger', ${groupId},
              ${JSON.stringify({ ...cmd, state: newState, device_id: group.device_id })},
              ${req.ip})
    `
    return { ok: true, state: newState }
  })
}

module.exports = userRoutes
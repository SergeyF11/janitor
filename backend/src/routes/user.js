'use strict'
const { getDb } = require('../db/connection')
const { authenticate } = require('../services/auth.service')

async function userRoutes(app) {

  // GET /api/user/groups — группы с реле
  app.get('/user/groups', {
    onRequest: [authenticate]
  }, async (req) => {
    const db = getDb()

    const groups = await db`
      SELECT
        g.id, g.name, g.mqtt_topic, g.status, g.expires_at, g.grace_until, g.blocked_at,
        ug.role, ug.description,
        d.device_id,
        COALESCE(d.is_online, false) AS device_online
      FROM groups g
      JOIN user_groups ug ON ug.group_id = g.id
      LEFT JOIN devices d ON d.group_id = g.id
      WHERE ug.user_id = ${req.user.id}
        AND g.status IN ('active', 'blocked')
        AND (g.expires_at IS NULL OR g.expires_at > NOW() - INTERVAL '7 months')
      ORDER BY g.name
    `

    const result = []
    for (const group of groups) {
      let relays = []
      if (group.device_id) {
        relays = await db`
          SELECT id, relay_index, name, duration_ms, last_state
          FROM relays
          WHERE device_id = ${group.device_id}
          ORDER BY relay_index
        `
      }
      result.push({ ...group, relays })
    }
    return result
  })

  // POST /api/user/relays/:relayId/trigger
  app.post('/user/relays/:relayId/trigger', {
    onRequest: [authenticate]
  }, async (req, reply) => {
    const db      = getDb()
    const relayId = req.params.relayId

    const [relay] = await db`
      SELECT r.id, r.name, r.duration_ms, r.device_id, r.last_state,
             d.mqtt_user, COALESCE(d.is_online, false) AS is_online,
             g.id AS group_id, g.status AS group_status
      FROM relays r
      JOIN devices d ON d.device_id = r.device_id
      JOIN groups  g ON g.id = d.group_id
      JOIN user_groups ug ON ug.group_id = g.id
      WHERE r.id = ${relayId}
        AND ug.user_id = ${req.user.id}
      LIMIT 1
    `

    if (!relay) return reply.code(404).send({ error: 'not_found' })

    // Проверка: группа заблокирована или истёк льготный период
    const now = new Date()
    const graceUntil = relay.grace_until ? new Date(relay.grace_until) : null
    const expiresAt  = relay.expires_at  ? new Date(relay.expires_at)  : null
    const blocked = relay.group_status === 'blocked'
      || (expiresAt && expiresAt < now && (!graceUntil || graceUntil < now))
    if (blocked) {
      await db`
        INSERT INTO event_log (action, actor_id, actor_login, group_id, relay_id, payload, ip)
        VALUES ('relay_trigger_blocked', ${req.user.id}, ${req.user.login},
                ${relay.group_id}, ${relayId},
                ${{ relay: relay.name, reason: 'group_blocked' }}, ${req.ip})
      `
      return reply.code(403).send({ error: 'group_blocked' })
    }
    if (!relay.device_id) return reply.code(503).send({ error: 'no_device' })
    if (!relay.is_online) return reply.code(503).send({ error: 'device_offline' })

    let action, newState
    if (relay.duration_ms === 0) {
      newState = relay.last_state === 'on' ? 'off' : 'on'
      action   = newState
    } else {
      newState = 'pulse'
      action   = 'pulse'
    }

    const cmd   = { relay: relay.name, action, ...(action === 'pulse' ? { duration: relay.duration_ms } : {}) }
    const topic = `$devices/${relay.mqtt_user}/commands`

    const mqttClient = app.mqtt
    if (!mqttClient?.connected) return reply.code(503).send({ error: 'mqtt_unavailable' })
    mqttClient.publish(topic, JSON.stringify(cmd), { qos: 1 })

    await db`
      INSERT INTO event_log (action, actor_id, actor_login, group_id, relay_id, payload)
      VALUES ('relay_trigger', ${req.user.id}, ${req.user.login},
              ${relay.group_id}, ${relayId},
              ${ {relay: relay.name, action, state: newState} })
    `

    return { ok: true, state: newState }
  })

  // GET /api/user/me
  app.get('/user/me', {
    onRequest: [authenticate]
  }, async (req) => {
    const db = getDb()
    const [user] = await db`
      SELECT id, login, role, single_session, must_change_password, display_name, phone
      FROM users WHERE id = ${req.user.id}
    `
    return user
  })
}

module.exports = userRoutes

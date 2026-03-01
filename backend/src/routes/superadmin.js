'use strict'
const { getDb } = require('../db/connection')
const { createUser, resetUserSessions, changePassword, authenticate, requireRole } = require('../services/auth.service')

const isSuperAdmin = requireRole('superadmin')

async function superadminRoutes(app) {

  // ── АДМИНИСТРАТОРЫ ────────────────────────────────────────────

  // GET /api/sa/admins
  app.get('/sa/admins', {
    onRequest: [authenticate, isSuperAdmin]
  }, async () => {
    const db = getDb()
    return db`
      SELECT u.id, u.login, u.display_name, u.email, u.phone,
             u.single_session, u.is_active, u.created_at,
             creator.login as created_by_login,
             EXISTS(
               SELECT 1 FROM refresh_tokens rt
               WHERE rt.user_id = u.id AND rt.expires_at > NOW()
             ) as has_session,
             (
               SELECT json_agg(json_build_object('id', g.id, 'name', g.name))
               FROM user_groups ug
               JOIN groups g ON g.id = ug.group_id
               WHERE ug.user_id = u.id AND ug.role = 'admin'
             ) as groups
      FROM users u
      LEFT JOIN users creator ON creator.id = u.created_by
      WHERE u.role = 'admin'
      ORDER BY u.created_at DESC
    `
  })

  // POST /api/sa/admins — создать администратора
  app.post('/sa/admins', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['login', 'password'],
        properties: {
          login:          { type: 'string', minLength: 3, maxLength: 100 },
          password:       { type: 'string', minLength: 6 },
          single_session: { type: 'boolean', default: true },
          display_name:   { type: 'string', maxLength: 200 },
          phone:          { type: 'string', maxLength: 50 },
          email:          { type: 'string', maxLength: 200 },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { login, password, single_session = true, display_name, phone, email } = req.body

    const [taken] = await db`SELECT id FROM users WHERE login = ${login}`
    if (taken) return reply.code(409).send({ error: 'login_taken' })

    const user = await createUser(login, password, 'admin', req.user.id, {
      must_change_password: true,
      single_session,
      display_name: display_name || null,
      phone:        phone || null,
      email:        email || null,
    })

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'create_admin', 'user', ${user.id},
              ${JSON.stringify({ login, single_session })})
    `
    return reply.code(201).send(user)
  })

  // PATCH /api/sa/admins/:id — изменить флаги администратора
  app.patch('/sa/admins/:id', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          single_session: { type: 'boolean' },
          is_active:      { type: 'boolean' },
          display_name:   { type: 'string', maxLength: 200 },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { single_session, is_active, display_name } = req.body
    const targetId = req.params.id

    const updates = {}
    if (single_session !== undefined) updates.single_session = single_session
    if (is_active      !== undefined) updates.is_active      = is_active
    if (display_name   !== undefined) updates.display_name   = display_name

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'nothing_to_update' })
    }

    // Строим UPDATE динамически
    if (single_session !== undefined) {
      await db`UPDATE users SET single_session = ${single_session}, updated_at = NOW() WHERE id = ${targetId} AND role = 'admin'`
    }
    if (is_active !== undefined) {
      await db`UPDATE users SET is_active = ${is_active}, updated_at = NOW() WHERE id = ${targetId} AND role = 'admin'`
      // Если деактивируем — сбрасываем сессии
      if (!is_active) await resetUserSessions(targetId, req.user.id)
    }
    if (display_name !== undefined) {
      await db`UPDATE users SET display_name = ${display_name}, updated_at = NOW() WHERE id = ${targetId}`
    }

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'update_admin', 'user', ${targetId},
              ${JSON.stringify(updates)})
    `
    return { ok: true }
  })

  // DELETE /api/sa/admins/:id — удалить администратора
  app.delete('/sa/admins/:id', {
    onRequest: [authenticate, isSuperAdmin]
  }, async (req, reply) => {
    const db = getDb()
    const targetId = req.params.id

    const [target] = await db`SELECT login, role FROM users WHERE id = ${targetId}`
    if (!target) return reply.code(404).send({ error: 'not_found' })
    if (target.role === 'superadmin') return reply.code(403).send({ error: 'forbidden' })

    await resetUserSessions(targetId, req.user.id)
    // Удаляем из групп — триггер не удалит (role=admin), удаляем вручную
    await db`DELETE FROM user_groups WHERE user_id = ${targetId}`
    await db`DELETE FROM users WHERE id = ${targetId}`

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'delete_admin', 'user', ${targetId},
              ${JSON.stringify({ login: target.login })})
    `
    return { ok: true }
  })

  // POST /api/sa/admins/:id/reset-sessions
  app.post('/sa/admins/:id/reset-sessions', {
    onRequest: [authenticate, isSuperAdmin]
  }, async (req, reply) => {
    await resetUserSessions(req.params.id, req.user.id)
    return { ok: true }
  })

  // POST /api/sa/admins/:id/reset-password
  app.post('/sa/admins/:id/reset-password', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    await changePassword(req.params.id, req.body.password, false)
    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id)
      VALUES (${req.user.id}, ${req.user.login}, 'reset_password', 'user', ${req.params.id})
    `
    return { ok: true }
  })

  // ── ГРУППЫ ───────────────────────────────────────────────────

  // GET /api/sa/groups
  app.get('/sa/groups', {
    onRequest: [authenticate, isSuperAdmin]
  }, async () => {
    const db = getDb()
    return db`
      SELECT g.id, g.name, g.mqtt_topic, g.relay_duration_ms,
             g.status, g.expires_at, g.grace_until, g.user_quota,
             g.created_at, g.updated_at,
             COUNT(ug.user_id) FILTER (WHERE ug.role = 'user')  as user_count,
             COUNT(ug.user_id) FILTER (WHERE ug.role = 'admin') as admin_count,
             (
               SELECT json_agg(json_build_object('id', u.id, 'login', u.login))
               FROM user_groups ug2
               JOIN users u ON u.id = ug2.user_id
               WHERE ug2.group_id = g.id AND ug2.role = 'admin'
             ) as admins,
             (
               SELECT json_agg(json_build_object(
                 'device_id', d.device_id,
                 'last_seen', d.last_seen,
                 'is_online', d.last_seen > NOW() - INTERVAL '2 minutes',
                 'relay_index', dg.relay_index
               ))
               FROM device_groups dg
               JOIN devices d ON d.device_id = dg.device_id
               WHERE dg.group_id = g.id
             ) as devices
      FROM groups g
      LEFT JOIN user_groups ug ON ug.group_id = g.id
      GROUP BY g.id
      ORDER BY g.name
    `
  })

  // POST /api/sa/groups
  app.post('/sa/groups', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'mqtt_topic'],
        properties: {
          name:              { type: 'string', minLength: 1, maxLength: 100 },
          mqtt_topic:        { type: 'string', minLength: 1, maxLength: 100 },
          relay_duration_ms: { type: 'integer', minimum: 0, default: 500 },
          user_quota:        { type: 'integer', minimum: 0, default: 0 },
          expires_at:        { type: 'string', format: 'date-time' },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { name, mqtt_topic, relay_duration_ms = 500, user_quota = 0, expires_at } = req.body

    const [taken] = await db`SELECT id FROM groups WHERE mqtt_topic = ${mqtt_topic}`
    if (taken) return reply.code(409).send({ error: 'mqtt_topic_taken' })

    const [group] = await db`
      INSERT INTO groups (name, mqtt_topic, relay_duration_ms, user_quota, expires_at, created_by)
      VALUES (${name}, ${mqtt_topic}, ${relay_duration_ms}, ${user_quota},
              ${expires_at || null}, ${req.user.id})
      RETURNING *
    `
    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'create_group', 'group', ${group.id},
              ${JSON.stringify({ name, mqtt_topic })})
    `
    return reply.code(201).send(group)
  })

  // PATCH /api/sa/groups/:id
  app.patch('/sa/groups/:id', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          name:              { type: 'string', minLength: 1, maxLength: 100 },
          relay_duration_ms: { type: 'integer', minimum: 0 },
          user_quota:        { type: 'integer', minimum: 0 },
          status:            { type: 'string', enum: ['active', 'blocked'] },
          expires_at:        { type: 'string', format: 'date-time' },
          grace_until:       { type: 'string', format: 'date-time' },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const id = req.params.id
    const { name, relay_duration_ms, user_quota, status, expires_at, grace_until } = req.body

    if (name              !== undefined) await db`UPDATE groups SET name = ${name}, updated_at = NOW() WHERE id = ${id}`
    if (relay_duration_ms !== undefined) await db`UPDATE groups SET relay_duration_ms = ${relay_duration_ms}, updated_at = NOW() WHERE id = ${id}`
    if (user_quota        !== undefined) await db`UPDATE groups SET user_quota = ${user_quota}, updated_at = NOW() WHERE id = ${id}`
    if (status            !== undefined) await db`UPDATE groups SET status = ${status}, updated_at = NOW() WHERE id = ${id}`
    if (expires_at        !== undefined) await db`UPDATE groups SET expires_at = ${expires_at}, updated_at = NOW() WHERE id = ${id}`
    if (grace_until       !== undefined) await db`UPDATE groups SET grace_until = ${grace_until}, updated_at = NOW() WHERE id = ${id}`

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'update_group', 'group', ${id},
              ${JSON.stringify(req.body)})
    `
    return { ok: true }
  })

  // DELETE /api/sa/groups/:id
  app.delete('/sa/groups/:id', {
    onRequest: [authenticate, isSuperAdmin]
  }, async (req, reply) => {
    const db = getDb()
    const [group] = await db`SELECT name FROM groups WHERE id = ${req.params.id}`
    if (!group) return reply.code(404).send({ error: 'not_found' })

    await db`DELETE FROM groups WHERE id = ${req.params.id}`
    // CASCADE удалит user_groups → триггер удалит осиротевших users
    // CASCADE удалит device_groups, device_tokens

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'delete_group', 'group', ${req.params.id},
              ${JSON.stringify({ name: group.name })})
    `
    return { ok: true }
  })

  // POST /api/sa/groups/:id/admins — назначить администратора группы
  app.post('/sa/groups/:id/admins', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['admin_id'],
        properties: {
          admin_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const groupId  = req.params.id
    const adminId  = req.body.admin_id

    const [admin] = await db`SELECT id, role FROM users WHERE id = ${adminId}`
    if (!admin) return reply.code(404).send({ error: 'user_not_found' })
    if (admin.role !== 'admin') return reply.code(400).send({ error: 'user_is_not_admin' })

    await db`
      INSERT INTO user_groups (user_id, group_id, role, created_by)
      VALUES (${adminId}, ${groupId}, 'admin', ${req.user.id})
      ON CONFLICT (user_id, group_id) DO UPDATE SET role = 'admin'
    `
    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, group_id)
      VALUES (${req.user.id}, ${req.user.login}, 'assign_group_admin', 'user', ${adminId}, ${groupId})
    `
    return { ok: true }
  })

  // DELETE /api/sa/groups/:id/admins/:adminId — снять администратора с группы
  app.delete('/sa/groups/:id/admins/:adminId', {
    onRequest: [authenticate, isSuperAdmin]
  }, async (req, reply) => {
    const db = getDb()
    await db`
      DELETE FROM user_groups
      WHERE group_id = ${req.params.id} AND user_id = ${req.params.adminId} AND role = 'admin'
    `
    return { ok: true }
  })

  // ── ПОЛЬЗОВАТЕЛИ (глобально) ──────────────────────────────────

  // GET /api/sa/users — все пользователи системы
  app.get('/sa/users', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          role:   { type: 'string', enum: ['user', 'admin', 'superadmin'] },
          search: { type: 'string' },
          limit:  { type: 'integer', default: 50, maximum: 200 },
          offset: { type: 'integer', default: 0 },
        }
      }
    }
  }, async (req) => {
    const db = getDb()
    const { role, search, limit = 50, offset = 0 } = req.query

    return db`
      SELECT u.id, u.login, u.display_name, u.email, u.phone,
             u.role, u.single_session, u.is_active,
             u.must_change_password, u.created_at,
             creator.login as created_by_login,
             EXISTS(
               SELECT 1 FROM refresh_tokens rt
               WHERE rt.user_id = u.id AND rt.expires_at > NOW()
             ) as has_session,
             (
               SELECT COUNT(*) FROM user_groups ug WHERE ug.user_id = u.id
             ) as group_count
      FROM users u
      LEFT JOIN users creator ON creator.id = u.created_by
      WHERE (${role}::text   IS NULL OR u.role = ${role}::user_role)
        AND (${search}::text IS NULL OR u.login ILIKE ${'%' + (search || '') + '%'}
             OR u.display_name ILIKE ${'%' + (search || '') + '%'})
      ORDER BY u.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  })

  // POST /api/sa/users/:id/reset-password
  app.post('/sa/users/:id/reset-password', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    await changePassword(req.params.id, req.body.password, false)
    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id)
      VALUES (${req.user.id}, ${req.user.login}, 'reset_password', 'user', ${req.params.id})
    `
    return { ok: true }
  })

  // POST /api/sa/users/:id/reset-sessions
  app.post('/sa/users/:id/reset-sessions', {
    onRequest: [authenticate, isSuperAdmin]
  }, async (req, reply) => {
    await resetUserSessions(req.params.id, req.user.id)
    return { ok: true }
  })

  // PATCH /api/sa/users/:id — изменить флаги любого пользователя
  app.patch('/sa/users/:id', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          single_session: { type: 'boolean' },
          is_active:      { type: 'boolean' },
          display_name:   { type: 'string', maxLength: 200 },
          phone:          { type: 'string', maxLength: 50 },
          email:          { type: 'string', maxLength: 200 },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const id = req.params.id
    const { single_session, is_active, display_name, phone, email } = req.body

    if (single_session !== undefined) await db`UPDATE users SET single_session = ${single_session}, updated_at = NOW() WHERE id = ${id}`
    if (display_name   !== undefined) await db`UPDATE users SET display_name   = ${display_name},   updated_at = NOW() WHERE id = ${id}`
    if (phone          !== undefined) await db`UPDATE users SET phone          = ${phone},           updated_at = NOW() WHERE id = ${id}`
    if (email          !== undefined) await db`UPDATE users SET email          = ${email},           updated_at = NOW() WHERE id = ${id}`
    if (is_active      !== undefined) {
      await db`UPDATE users SET is_active = ${is_active}, updated_at = NOW() WHERE id = ${id} AND role != 'superadmin'`
      if (!is_active) await resetUserSessions(id, req.user.id)
    }

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'update_user', 'user', ${id},
              ${JSON.stringify(req.body)})
    `
    return { ok: true }
  })

  // ── УСТРОЙСТВА (глобально) ────────────────────────────────────

  // GET /api/sa/devices
  app.get('/sa/devices', {
    onRequest: [authenticate, isSuperAdmin]
  }, async () => {
    const db = getDb()
    return db`
      SELECT d.device_id, d.mqtt_user, d.fw_version, d.last_seen, d.registered_at,
             CASE WHEN d.last_seen > NOW() - INTERVAL '2 minutes' THEN true ELSE false END as is_online,
             json_agg(json_build_object('group_id', g.id, 'name', g.name, 'relay_index', dg.relay_index)) as groups
      FROM devices d
      LEFT JOIN device_groups dg ON dg.device_id = d.device_id
      LEFT JOIN groups g ON g.id = dg.group_id
      GROUP BY d.device_id
      ORDER BY d.registered_at DESC
    `
  })

  // DELETE /api/sa/devices/:deviceId — удалить устройство
  app.delete('/sa/devices/:deviceId', {
    onRequest: [authenticate, isSuperAdmin]
  }, async (req, reply) => {
    const db = getDb()
    await db`DELETE FROM devices WHERE device_id = ${req.params.deviceId}`
    return { ok: true }
  })

  // ── ЖУРНАЛЫ ───────────────────────────────────────────────────

  // GET /api/sa/logs — полный журнал
  app.get('/sa/logs', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          action:   { type: 'string' },
          actor_id: { type: 'string' },
          group_id: { type: 'string' },
          from:     { type: 'string', format: 'date-time' },
          to:       { type: 'string', format: 'date-time' },
          limit:    { type: 'integer', default: 100, maximum: 1000 },
          offset:   { type: 'integer', default: 0 },
        }
      }
    }
  }, async (req) => {
    const db = getDb()
    const { action, actor_id, group_id, from, to, limit = 100, offset = 0 } = req.query

    return db`
      SELECT el.id, el.action, el.actor_login, el.actor_id,
             el.target_type, el.target_id, el.group_id,
             el.payload, el.ip, el.ts,
             g.name as group_name
      FROM event_log el
      LEFT JOIN groups g ON g.id = el.group_id
      WHERE (${action}::text   IS NULL OR el.action   = ${action})
        AND (${actor_id}::text IS NULL OR el.actor_id = ${actor_id}::uuid)
        AND (${group_id}::text IS NULL OR el.group_id = ${group_id}::uuid)
        AND (${from}::text     IS NULL OR el.ts >= ${from}::timestamptz)
        AND (${to}::text       IS NULL OR el.ts <= ${to}::timestamptz)
      ORDER BY el.ts DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  })

  // ── СТАТИСТИКА ────────────────────────────────────────────────

  // GET /api/sa/stats
  app.get('/sa/stats', {
    onRequest: [authenticate, isSuperAdmin]
  }, async () => {
    const db = getDb()
    const [stats] = await db`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'user')      as total_users,
        (SELECT COUNT(*) FROM users WHERE role = 'admin')     as total_admins,
        (SELECT COUNT(*) FROM groups)                         as total_groups,
        (SELECT COUNT(*) FROM devices)                        as total_devices,
        (SELECT COUNT(*) FROM devices
         WHERE last_seen > NOW() - INTERVAL '2 minutes')      as online_devices,
        (SELECT COUNT(*) FROM refresh_tokens
         WHERE expires_at > NOW())                            as active_sessions,
        (SELECT COUNT(*) FROM event_log
         WHERE ts > NOW() - INTERVAL '24 hours')              as events_24h,
        (SELECT COUNT(*) FROM event_log
         WHERE action = 'login'
           AND ts > NOW() - INTERVAL '24 hours')              as logins_24h
    `
    return stats
  })

  // ── ПРЯМЫЕ SQL ЗАПРОСЫ (только для суперадмина) ───────────────
  // Доступно только через /janitor/superadmin UI
  app.post('/sa/query', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['sql'],
        properties: {
          sql: { type: 'string', maxLength: 5000 }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const sql = req.body.sql.trim()

    // Запрещаем опасные операции
    const forbidden = /\b(DROP|TRUNCATE|DELETE\s+FROM\s+users|ALTER|CREATE|INSERT\s+INTO\s+users)\b/i
    if (forbidden.test(sql)) {
      return reply.code(403).send({ error: 'forbidden_operation' })
    }

    try {
      const result = await db.unsafe(sql)
      await db`
        INSERT INTO event_log (actor_id, actor_login, action, payload)
        VALUES (${req.user.id}, ${req.user.login}, 'raw_sql',
                ${JSON.stringify({ sql: sql.substring(0, 200) })})
      `
      return { rows: result, count: result.length }
    } catch (err) {
      return reply.code(400).send({ error: err.message })
    }
  })
}

module.exports = superadminRoutes
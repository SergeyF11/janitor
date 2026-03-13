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
              ${{ login, single_session }})
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
              ${updates})
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
              ${{ login: target.login }})
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
             g.status, g.expires_at, g.grace_until, g.blocked_at, g.user_quota,
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
                 'is_online', d.is_online,
                 'relay_index', dg.relay_index
               ))
               FROM device_groups dg
               JOIN devices d ON d.device_id = dg.device_id
               WHERE dg.group_id = g.id
             ) as devices
      FROM groups g
      LEFT JOIN user_groups ug ON ug.group_id = g.id
      WHERE g.status != 'deleted'
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
    // Автоматически создать администратора группы: login = mqtt_topic, пароль случайный
    const crypto  = require('crypto')
    const bcrypt  = require('bcryptjs')
    const chars   = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    const rbytes  = crypto.randomBytes(12)
    let adminPass = ''
    for (let i = 0; i < 12; i++) adminPass += chars[rbytes[i] % chars.length]
    const hash    = await bcrypt.hash(adminPass, 12)

    const [adminUser] = await db`
      INSERT INTO users (login, password_hash, role, must_change_password, single_session, created_by)
      VALUES (${mqtt_topic}, ${hash}, 'admin', false, false, ${req.user.id})
      ON CONFLICT (login) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            role          = 'admin',
            is_active     = true,
            updated_at    = NOW()
      RETURNING id, login
    `
    await db`
      INSERT INTO user_groups (user_id, group_id, role, created_by)
      VALUES (${adminUser.id}, ${group.id}, 'admin', ${req.user.id})
      ON CONFLICT (user_id, group_id) DO NOTHING
    `

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'create_group', 'group', ${group.id},
              ${{ name, mqtt_topic, admin_login: mqtt_topic }})
    `
    const responseBody = {
      id:                group.id,
      name:              group.name,
      mqtt_topic:        group.mqtt_topic,
      status:            group.status,
      relay_duration_ms: group.relay_duration_ms,
      user_quota:        group.user_quota,
      expires_at:        group.expires_at,
      admin_login:       mqtt_topic,
      admin_password:    adminPass,
    }
    console.log('[sa] create_group response:', JSON.stringify(responseBody))
    return reply.code(201).send(responseBody)
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
          status:            { type: 'string', enum: ['active', 'blocked', 'grace', 'deleted'] },
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
    if (grace_until       !== undefined) await db`UPDATE groups SET grace_until = ${grace_until}, updated_at = NOW() WHERE id = ${id}`

    // Обновление expires_at: если дата в будущем — реактивировать группу
    if (expires_at !== undefined) {
      const newExpiry = expires_at ? new Date(expires_at) : null
      const isReactivation = newExpiry && newExpiry > new Date()
      await db`
        UPDATE groups SET
          expires_at  = ${newExpiry},
          grace_until = ${isReactivation ? null : undefined},
          blocked_at  = ${isReactivation ? null : undefined},
          status      = ${isReactivation ? 'active' : undefined},
          updated_at  = NOW()
        WHERE id = ${id}
      `
      if (isReactivation) {
        await db`
          INSERT INTO event_log (action, target_type, target_id, payload)
          VALUES ('group_reactivated', 'group', ${id},
                  ${{ expires_at: newExpiry, by: req.user.login }})
        `
        console.log(`[sa] Group reactivated: ${id} until ${newExpiry.toISOString()}`)
      }
    }

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'update_group', 'group', ${id},
              ${ req.body })
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
              ${{ name: group.name }})
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
        role:     { type: 'string', enum: ['user', 'admin', 'superadmin'] },
        search:   { type: 'string' },
        group_id: { type: 'string', format: 'uuid' },
        limit:    { type: 'integer', default: 50, maximum: 200 },
        offset:   { type: 'integer', default: 0 },
      }
    }
  }
}, async (req) => {
  const db = getDb()
  const { role, search, group_id, limit = 50, offset = 0 } = req.query

  console.log('GET /sa/users params:', { role, search, group_id, limit, offset })

  try {
    // Базовый запрос
    let query = db`
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
    `

    const conditions = []
    
    if (role) {
      conditions.push(db`u.role = ${role}::user_role`)
    }
    
    if (search) {
      conditions.push(db`(u.login ILIKE ${'%' + search + '%'} 
                          OR u.display_name ILIKE ${'%' + search + '%'} 
                          OR u.id::text ILIKE ${'%' + search + '%'})`)
    }
    
    if (group_id && group_id.trim() !== '') {
      conditions.push(db`EXISTS (
        SELECT 1 FROM user_groups ug 
        WHERE ug.user_id = u.id AND ug.group_id = ${group_id}::uuid
      )`)
    }

    // if (conditions.length > 0) {
    //   query = db`${query} WHERE ${db.join(conditions, ' AND ')}`
    // }
    if (conditions.length > 0) {
      query = db`${query} WHERE ${conditions[0]}`
      for (let i = 1; i < conditions.length; i++) {
        query = db`${query} AND ${conditions[i]}`
      }
    }

    query = db`${query} ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`
    
    const result = await query
    return result
  } catch (err) {
    console.error('Error in GET /sa/users:', err)
    throw err // пробрасываем ошибку дальше, чтобы вернуть 500
  }
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
              ${req.body})
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
             COALESCE(d.is_online, false) AS is_online, d.group_id,
             g.name as group_name
      FROM devices d
      LEFT JOIN groups g ON g.id = d.group_id
      ORDER BY d.registered_at DESC
    `
  })

  // DELETE /api/sa/devices/:deviceId — удалить устройство
  app.delete('/sa/devices/:deviceId', {
    onRequest: [authenticate, isSuperAdmin]
  }, async (req, reply) => {
    const db       = getDb()
    const deviceId = req.params.deviceId.replace(/[:\-]/g, '').toUpperCase()

    // Получить mqtt_user перед удалением
    const [device] = await db`
      SELECT mqtt_user FROM devices WHERE device_id = ${deviceId}
    `

    await db`DELETE FROM devices WHERE device_id = ${deviceId}`

    // Удалить из YC IoT Core
    if (device?.mqtt_user) {
      try {
        const { deleteYcDevice } = require('./device')
        await deleteYcDevice(device.mqtt_user)
      } catch (e) { console.warn('[sa] YC delete error:', e.message) }
    }

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'device_deleted', 'device', ${deviceId},
              ${{ mqtt_user: device?.mqtt_user }})
    `

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

    // Базовый запрос
    let query = db`
      SELECT el.id, el.action, el.actor_login, el.actor_id,
             el.target_type, el.target_id, el.group_id,
             el.payload, el.ip, el.ts,
             g.name as group_name
      FROM event_log el
      LEFT JOIN groups g ON g.id = el.group_id
    `

    // Массив условий
    const where = []

    if (action) where.push(db`el.action = ${action}`)
    if (actor_id && actor_id.trim() !== '') where.push(db`el.actor_id = ${actor_id}::uuid`)
    if (group_id && group_id.trim() !== '') where.push(db`el.group_id = ${group_id}::uuid`)
    if (from) where.push(db`el.ts >= ${from}::timestamptz`)
    if (to) where.push(db`el.ts <= ${to}::timestamptz`)

    // Добавляем WHERE, если есть условия
    if (where.length > 0) {
      query = db`${query} WHERE ${db.join(where, ' AND ')}`
    }

    // Добавляем сортировку и пагинацию
    query = db`${query} ORDER BY el.ts DESC LIMIT ${limit} OFFSET ${offset}`
    console.log('Final query built, conditions count:', where.length)

    return query
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
         WHERE COALESCE(is_online, false) = true) as online_devices,
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
                ${{ sql: sql.substring(0, 200) }})
      `
      return { rows: result, count: result.length }
    } catch (err) {
      return reply.code(400).send({ error: err.message })
    }
  })
}

module.exports = superadminRoutes
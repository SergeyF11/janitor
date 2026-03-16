'use strict'
const { getDb } = require('../db/connection')
const { createUser, resetUserSessions, changePassword, authenticate, requireRole } = require('../services/auth.service')
const { deleteYcDevice } = require('./device')

const isSuperAdmin = requireRole('superadmin')

async function superadminRoutes(app) {

  // ── АДМИНИСТРАТОРЫ ────────────────────────────────────────────

 app.get('/sa/admins', { onRequest: [authenticate, isSuperAdmin] }, async () => {
  const db = getDb()
  return db`
    SELECT
      u.id,
      u.login,
      u.display_name,
      u.single_session,
      u.is_active,
      u.created_at,
      g_reg.mqtt_topic AS registration_topic,
      EXISTS(SELECT 1 FROM refresh_tokens rt WHERE rt.user_id = u.id AND rt.expires_at > NOW()) as has_session,
      (
        SELECT json_agg(
          json_build_object(
            'id', g.id,
            'name', g.name,
            'mqtt_topic', g.mqtt_topic,
            'role', ug.role,
            'description', ug.description
          )
        )
        FROM user_groups ug
        JOIN groups g ON g.id = ug.group_id
        WHERE ug.user_id = u.id AND ug.role = 'admin'
      ) as admin_groups
    FROM users u
    LEFT JOIN groups g_reg ON g_reg.id = u.registration_group_id
    WHERE u.role = 'admin' OR u.role = 'superadmin' -- superadmin тоже покажем?
    ORDER BY u.created_at DESC
  `
})

 app.post('/sa/admins', {
  onRequest: [authenticate, isSuperAdmin],
  schema: {
    body: {
      type: 'object', required: ['login', 'password', 'group_id'],
      properties: {
        login:          { type: 'string', minLength: 3, maxLength: 100 },
        password:       { type: 'string', minLength: 6 },
        group_id:       { type: 'string', format: 'uuid' },
        single_session: { type: 'boolean', default: true },
        display_name:   { type: 'string', maxLength: 200 },
        phone:          { type: 'string', maxLength: 50 },
        description:    { type: 'string', maxLength: 500 }, // описание в этой группе
      }
    }
  }
}, async (req, reply) => {
  const db = getDb()
  const { login, password, group_id, single_session = true, display_name, phone, description } = req.body

  // Проверить существование группы
  const [group] = await db`SELECT id FROM groups WHERE id = ${group_id}`
  if (!group) return reply.code(404).send({ error: 'group_not_found' })

  // Проверка квоты группы
  const [groupInfo] = await db`
    SELECT user_quota, (SELECT COUNT(*) FROM user_groups WHERE group_id = ${group_id}) AS member_count
    FROM groups WHERE id = ${group_id}
  `
  if (groupInfo.user_quota > 0 && parseInt(groupInfo.member_count) >= groupInfo.user_quota) {
    return reply.code(403).send({ error: 'quota_exceeded' })
  }

  // Проверить уникальность логина в группе регистрации
  const [taken] = await db`
    SELECT id FROM users
    WHERE login = ${login} AND registration_group_id = ${group_id}
  `
  if (taken) return reply.code(409).send({ error: 'login_taken_in_group' })

  // Создать пользователя с registration_group_id = group_id, роль admin
  const user = await createUser(
    login,
    password,
    'admin',
    req.user.id,
    group_id,
    {
      must_change_password: true,
      single_session,
      display_name: display_name || null,
      phone: phone || null,
    }
  )

  // Добавить запись в user_groups для этой группы с ролью admin и description
  await db`
    INSERT INTO user_groups (user_id, group_id, role, description, created_by)
    VALUES (${user.id}, ${group_id}, 'admin', ${description || null}, ${req.user.id})
    ON CONFLICT (user_id, group_id) DO UPDATE SET role = 'admin', description = EXCLUDED.description
  `

  return reply.code(201).send(user)
})


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
    const id = req.params.id
    if (single_session !== undefined) await db`UPDATE users SET single_session = ${single_session}, updated_at = NOW() WHERE id = ${id}`
    if (is_active      !== undefined) {
      await db`UPDATE users SET is_active = ${is_active}, updated_at = NOW() WHERE id = ${id}`
      if (!is_active) await resetUserSessions(id, req.user.id)
    }
    if (display_name   !== undefined) await db`UPDATE users SET display_name = ${display_name}, updated_at = NOW() WHERE id = ${id}`
    return { ok: true }
  })

  app.delete('/sa/admins/:id', { onRequest: [authenticate, isSuperAdmin] }, async (req, reply) => {
    const db = getDb()
    const [target] = await db`SELECT login, role FROM users WHERE id = ${req.params.id}`
    if (!target) return reply.code(404).send({ error: 'not_found' })
    if (target.role === 'superadmin') return reply.code(403).send({ error: 'forbidden' })
    await resetUserSessions(req.params.id, req.user.id)
    await db`DELETE FROM user_groups WHERE user_id = ${req.params.id}`
    await db`DELETE FROM users WHERE id = ${req.params.id}`
    return { ok: true }
  })

  app.post('/sa/admins/:id/reset-sessions', { onRequest: [authenticate, isSuperAdmin] }, async (req) => {
    await resetUserSessions(req.params.id, req.user.id)
    return { ok: true }
  })

  app.post('/sa/admins/:id/reset-password', {
    onRequest: [authenticate, isSuperAdmin],
    schema: { body: { type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 6 } } } }
  }, async (req) => {
    await changePassword(req.params.id, req.body.password, false)
    return { ok: true }
  })

  // ── ГРУППЫ ───────────────────────────────────────────────────

 app.get('/sa/groups', { onRequest: [authenticate, isSuperAdmin] }, async () => {
  const db = getDb()
  return db`
    SELECT
      g.id,
      g.name,
      g.mqtt_topic,
      g.status,
      g.expires_at,
      g.grace_until,
      g.user_quota,
      g.created_at,
      g.updated_at,
      COUNT(ug.user_id) FILTER (WHERE ug.role = 'user')  as user_count,
      COUNT(ug.user_id) FILTER (WHERE ug.role = 'admin') as admin_count,
      d.device_id,
      d.is_online,
      d.fw_version,
      d.last_seen,
      (
        SELECT json_agg(
          json_build_object(
            'id', r.id,
            'index', r.relay_index,
            'name', r.name,
            'duration_ms', r.duration_ms,
            'state', r.last_state
          )
        )
        FROM relays r WHERE r.device_id = d.device_id
      ) as relays,
      (
        SELECT json_agg(
          json_build_object(
            'id', u.id,
            'login', u.login,
            'registration_topic', g_reg.mqtt_topic,
            'role', ug.role,
            'description', ug.description
          )
        )
        FROM user_groups ug
        JOIN users u ON u.id = ug.user_id
        LEFT JOIN groups g_reg ON g_reg.id = u.registration_group_id
        WHERE ug.group_id = g.id AND ug.role = 'admin'
      ) as admins
    FROM groups g
    LEFT JOIN user_groups ug ON ug.group_id = g.id
    LEFT JOIN devices d ON d.group_id = g.id
    GROUP BY g.id, d.device_id, d.is_online, d.fw_version, d.last_seen
    ORDER BY g.name
  `
})

 app.post('/sa/groups', {
  onRequest: [authenticate, isSuperAdmin],
    schema: {
      body: {
        type: 'object', required: ['name', 'mqtt_topic'],
        properties: {
          name:       { type: 'string', minLength: 1, maxLength: 100 },
          mqtt_topic: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9_-]+$' },
          user_quota: { type: 'integer', minimum: 0, default: 0 },
          expires_at: { type: 'string', format: 'date-time' },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { name, mqtt_topic, user_quota = 0, expires_at } = req.body

    const [taken] = await db`SELECT id FROM groups WHERE mqtt_topic = ${mqtt_topic}`
    if (taken) return reply.code(409).send({ error: 'mqtt_topic_taken' })

    // Вычисляем grace_until = expires_at + 1 месяц (30 дней)
    let grace_until = null
    if (expires_at) {
      const expiresDate = new Date(expires_at)
      grace_until = new Date(expiresDate.getTime() + 30 * 24 * 60 * 60 * 1000)
    }

    const [group] = await db`
      INSERT INTO groups (name, mqtt_topic, user_quota, expires_at, grace_until, created_by)
      VALUES (${name}, ${mqtt_topic}, ${user_quota}, ${expires_at || null}, ${grace_until}, ${req.user.id})
      RETURNING *
    `

  // Авто-создать администратора группы
  const adminLogin    = 'admin' //mqtt_topic  // или можно использовать mqtt_topic как логин
  const adminPassword = generatePassword(12)
  const bcrypt        = require('bcryptjs')
  const adminHash     = await bcrypt.hash(adminPassword, 12)

  // Проверяем, нет ли уже пользователя с таким логином в этой группе
  const [takenAdmin] = await db`
    SELECT id FROM users WHERE login = ${adminLogin} AND registration_group_id = ${group.id}
  `
  if (takenAdmin) {
    // если такой логин уже есть (маловероятно), генерируем уникальный
    adminLogin = mqtt_topic + '_' + Date.now()
  }

  const [admin] = await db`
    INSERT INTO users (login, registration_group_id, password_hash, role, must_change_password, single_session, created_by)
    VALUES (${adminLogin}, ${group.id}, ${adminHash}, 'admin', true, true, ${req.user.id})
    RETURNING id
  `

  // Добавляем запись в user_groups
  await db`
    INSERT INTO user_groups (user_id, group_id, role, created_by)
    VALUES (${admin.id}, ${group.id}, 'admin', ${req.user.id})
    ON CONFLICT DO NOTHING
  `

  return reply.code(201).send({
    ...group,
    admin_login:    adminLogin,
    admin_password: adminPassword,
  })
})

app.patch('/sa/groups/:id', {
  onRequest: [authenticate, isSuperAdmin],
  schema: {
    body: {
      type: 'object',
      properties: {
        name:        { type: 'string', minLength: 1, maxLength: 100 },
        user_quota:  { type: 'integer', minimum: 0 },
        status:      { type: 'string', enum: ['active', 'blocked'] },
        expires_at:  { type: ['string', 'null'],  format: 'date-time' },
      }
    }
  }
}, async (req, reply) => {
  const db = getDb()
  const id = req.params.id
  const { name, user_quota, status, expires_at } = req.body

  if (name        !== undefined) await db`UPDATE groups SET name = ${name}, updated_at = NOW() WHERE id = ${id}`
  if (user_quota  !== undefined) await db`UPDATE groups SET user_quota = ${user_quota}, updated_at = NOW() WHERE id = ${id}`
  //if (status      !== undefined) await db`UPDATE groups SET status = ${status}, updated_at = NOW() WHERE id = ${id}`
  if (status !== undefined) {
    if (status === 'blocked') {
      await db`UPDATE groups SET status = 'blocked', blocked_at = NOW(), updated_at = NOW() WHERE id = ${id}`
    } else if (status === 'active') {
      await db`UPDATE groups SET status = 'active', blocked_at = NULL, updated_at = NOW() WHERE id = ${id}`
    }
  }
  
  if (expires_at !== undefined) {
    let grace_until = null
    if (expires_at) {
      const expiresDate = new Date(expires_at)
      grace_until = new Date(expiresDate.getTime() + 30 * 24 * 60 * 60 * 1000)
    }
    await db`
      UPDATE groups 
      SET expires_at = ${expires_at}, grace_until = ${grace_until}, updated_at = NOW() 
      WHERE id = ${id}
    `
  }

  return { ok: true }
})

  app.delete('/sa/groups/:id', { onRequest: [authenticate, isSuperAdmin] }, async (req, reply) => {
    const db = getDb()
    const [group] = await db`SELECT name FROM groups WHERE id = ${req.params.id}`
    if (!group) return reply.code(404).send({ error: 'not_found' })
    await db`DELETE FROM groups WHERE id = ${req.params.id}`
    return { ok: true }
  })

app.post('/sa/groups/:id/admins', {
  onRequest: [authenticate, isSuperAdmin],
  schema: { body: { type: 'object', required: ['admin_id'], properties: { admin_id: { type: 'string', format: 'uuid' } } } }
}, async (req, reply) => {
  const db = getDb()
  const groupId = req.params.id
  const adminId = req.body.admin_id

  const [admin] = await db`SELECT id, role FROM users WHERE id = ${adminId}`
  if (!admin) return reply.code(404).send({ error: 'user_not_found' })
  if (admin.role !== 'admin' && admin.role !== 'superadmin') {
    return reply.code(400).send({ error: 'user_is_not_admin' })
  }

  // Проверить, не состоит ли уже
  const [exists] = await db`SELECT 1 FROM user_groups WHERE user_id = ${adminId} AND group_id = ${groupId}`
  if (exists) return reply.code(409).send({ error: 'already_in_group' })

  await db`
    INSERT INTO user_groups (user_id, group_id, role, created_by)
    VALUES (${adminId}, ${groupId}, 'admin', ${req.user.id})
  `

  return { ok: true }
})

app.delete('/sa/groups/:id/admins/:adminId', { onRequest: [authenticate, isSuperAdmin] }, async (req, reply) => {
  const db = getDb()
  const groupId = req.params.id
  const adminId = req.params.adminId

  // Удаляем запись из user_groups
  await db`DELETE FROM user_groups WHERE group_id = ${groupId} AND user_id = ${adminId} AND role = 'admin'`

  // Проверяем, остались ли у пользователя другие группы с ролью admin
  const [otherAdminGroups] = await db`
    SELECT COUNT(*) AS count FROM user_groups WHERE user_id = ${adminId} AND role = 'admin'
  `
  if (parseInt(otherAdminGroups.count) === 0) {
    // Если не осталось, понижаем глобальную роль до user (если это не суперадмин)
    await db`UPDATE users SET role = 'user' WHERE id = ${adminId} AND role != 'superadmin'`
  }

  return { ok: true }
})

  // ── ПОЛЬЗОВАТЕЛИ ─────────────────────────────────────────────

app.get('/sa/users', {
  onRequest: [authenticate, isSuperAdmin],
  schema: {
    querystring: {
      type: 'object',
      properties: {
        role:     { type: 'string' },
        search:   { type: 'string' },
        group_id: { type: 'string' },
        limit:    { type: 'integer', default: 50, maximum: 200 },
        offset:   { type: 'integer', default: 0 },
      }
    }
  }
}, async (req) => {
  const db = getDb()
  const { role, search, group_id, limit = 50, offset = 0 } = req.query

  let query = db`
    SELECT
      u.id,
      u.login,
      u.display_name,
      u.role,
      u.single_session,
      u.is_active,
      u.must_change_password,
      u.created_at,
      EXISTS(SELECT 1 FROM refresh_tokens rt WHERE rt.user_id = u.id AND rt.expires_at > NOW()) as has_session,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.user_id = u.id) as group_count,
      g_reg.mqtt_topic as registration_topic
    FROM users u
    LEFT JOIN groups g_reg ON g_reg.id = u.registration_group_id
  `

  const where = []
  if (role)     where.push(db`u.role = ${role}`)
  if (search)   where.push(db`(u.login ILIKE ${'%' + search + '%'} OR u.display_name ILIKE ${'%' + search + '%'})`)
  if (group_id) where.push(db`EXISTS (SELECT 1 FROM user_groups ug WHERE ug.user_id = u.id AND ug.group_id = ${group_id}::uuid)`)

  if (where.length > 0) {
    query = db`${query} WHERE ${where[0]}`
    for (let i = 1; i < where.length; i++) query = db`${query} AND ${where[i]}`
  }
  query = db`${query} ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`
  return query
})


  app.post('/sa/users/:id/reset-password', {
    onRequest: [authenticate, isSuperAdmin],
    schema: { body: { type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 6 } } } }
  }, async (req) => {
    await changePassword(req.params.id, req.body.password, false)
    return { ok: true }
  })

  app.post('/sa/users/:id/reset-sessions', { onRequest: [authenticate, isSuperAdmin] }, async (req) => {
    await resetUserSessions(req.params.id, req.user.id)
    return { ok: true }
  })

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
        }
      }
    }
  }, async (req) => {
    const db = getDb()
    const id = req.params.id
    const { single_session, is_active, display_name, phone } = req.body
    if (single_session !== undefined) await db`UPDATE users SET single_session = ${single_session}, updated_at = NOW() WHERE id = ${id}`
    if (display_name   !== undefined) await db`UPDATE users SET display_name = ${display_name}, updated_at = NOW() WHERE id = ${id}`
    if (phone          !== undefined) await db`UPDATE users SET phone = ${phone}, updated_at = NOW() WHERE id = ${id}`
    if (is_active      !== undefined) {
      await db`UPDATE users SET is_active = ${is_active}, updated_at = NOW() WHERE id = ${id} AND role != 'superadmin'`
      if (!is_active) await resetUserSessions(id, req.user.id)
    }
    return { ok: true }
  })

  // ── УСТРОЙСТВА ────────────────────────────────────────────────

  app.get('/sa/devices', { onRequest: [authenticate, isSuperAdmin] }, async () => {
    const db = getDb()
    return db`
      SELECT d.device_id, d.mqtt_user, d.fw_version, d.last_seen, d.registered_at,
             d.is_online, g.id as group_id, g.name as group_name,
             (SELECT json_agg(json_build_object('id', r.id, 'index', r.relay_index, 'name', r.name))
              FROM relays r WHERE r.device_id = d.device_id) as relays
      FROM devices d
      LEFT JOIN groups g ON g.id = d.group_id
      ORDER BY d.registered_at DESC
    `
  })

  app.delete('/sa/devices/:deviceId', { onRequest: [authenticate, isSuperAdmin] }, async (req, reply) => {
    const db       = getDb()
    const deviceId = req.params.deviceId.replace(/[:\-]/g, '').toUpperCase()

    const [device] = await db`SELECT mqtt_user FROM devices WHERE device_id = ${deviceId}`
    if (!device) return reply.code(404).send({ error: 'not_found' })

    await db`DELETE FROM devices WHERE device_id = ${deviceId}`

    // Удалить из YC Registry
    if (device.mqtt_user) await deleteYcDevice(device.mqtt_user)

    return { ok: true }
  })

  // ── СТАТИСТИКА ────────────────────────────────────────────────

  app.get('/sa/stats', { onRequest: [authenticate, isSuperAdmin] }, async () => {
    const db = getDb()
    const [stats] = await db`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'user')                              as total_users,
        (SELECT COUNT(*) FROM users WHERE role = 'admin')                             as total_admins,
        (SELECT COUNT(*) FROM groups)                                                 as total_groups,
        (SELECT COUNT(*) FROM devices)                                                as total_devices,
        (SELECT COUNT(*) FROM devices WHERE is_online = true)                         as online_devices,
        (SELECT COUNT(*) FROM refresh_tokens WHERE expires_at > NOW())                as active_sessions,
        (SELECT COUNT(*) FROM event_log WHERE ts > NOW() - INTERVAL '24 hours')       as events_24h
    `
    return stats
  })

  // ── RAW SQL ───────────────────────────────────────────────────

  app.post('/sa/query', {
    onRequest: [authenticate, isSuperAdmin],
    schema: { body: { type: 'object', required: ['sql'], properties: { sql: { type: 'string', maxLength: 5000 } } } }
  }, async (req, reply) => {
    const db  = getDb()
    const sql = req.body.sql.trim()
    const forbidden = /\b(DROP|TRUNCATE|DELETE\s+FROM\s+users|ALTER\s+TABLE|CREATE\s+TABLE)\b/i
    if (forbidden.test(sql)) return reply.code(403).send({ error: 'forbidden_operation' })
    try {
      const result = await db.unsafe(sql)
      return { rows: result, count: result.length }
    } catch (err) {
      return reply.code(400).send({ error: err.message })
    }
  })

  // ── ЖУРНАЛ ────────────────────────────────────────────────────

  app.get('/sa/logs', {
    onRequest: [authenticate, isSuperAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          action:   { type: 'string' },
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
    const { action, group_id, from, to, limit = 100, offset = 0 } = req.query

    let query = db`
      SELECT el.id, el.action, el.actor_login, el.target_type, el.target_id,
             el.group_id, el.payload, el.ip, el.ts, g.name as group_name
      FROM event_log el
      LEFT JOIN groups g ON g.id = el.group_id
    `
    const where = []
    if (action)   where.push(db`el.action = ${action}`)
    if (group_id) where.push(db`el.group_id = ${group_id}::uuid`)
    if (from)     where.push(db`el.ts >= ${from}::timestamptz`)
    if (to)       where.push(db`el.ts <= ${to}::timestamptz`)

    if (where.length > 0) {
      query = db`${query} WHERE ${where[0]}`
      for (let i = 1; i < where.length; i++) query = db`${query} AND ${where[i]}`
    }
    query = db`${query} ORDER BY el.ts DESC LIMIT ${limit} OFFSET ${offset}`
    return query
  })
}

function generatePassword(len = 12) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const { randomBytes } = require('crypto')
  const bytes = randomBytes(len)
  let pass = ''
  for (let i = 0; i < len; i++) pass += chars[bytes[i] % chars.length]
  return pass
}

module.exports = superadminRoutes

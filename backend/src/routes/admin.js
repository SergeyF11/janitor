'use strict'
const { getDb } = require('../db/connection')
const { createUser, resetUserSessions, authenticate, requireRole } = require('../services/auth.service')

// ── Проверка: текущий пользователь является админом группы ────
async function requireGroupAdmin(req, reply) {
  const db = getDb()
  const groupId = req.params.groupId || req.params.id
  if (!groupId) return reply.code(400).send({ error: 'groupId required' })

  // superadmin имеет доступ ко всем группам
  if (req.user.role === 'superadmin') return

  const [m] = await db`
    SELECT role FROM user_groups
    WHERE user_id = ${req.user.id} AND group_id = ${groupId}
  `
  if (!m || m.role !== 'admin') {
    return reply.code(403).send({ error: 'forbidden' })
  }
}

async function adminRoutes(app) {

  // ── ГРУППЫ ───────────────────────────────────────────────────

  // GET /api/admin/groups — группы где текущий пользователь является админом
  app.get('/admin/groups', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req) => {
    const db = getDb()
    return db`
      SELECT g.id, g.name, g.mqtt_topic, g.relay_duration_ms,
             g.status, g.expires_at, g.grace_until, g.user_quota,
             COUNT(ug.user_id) FILTER (WHERE ug.role = 'user') as user_count
      FROM groups g
      JOIN user_groups ug ON ug.group_id = g.id
      WHERE ug.user_id = ${req.user.id} AND ug.role = 'admin'
      GROUP BY g.id
      ORDER BY g.name
    `
  })

  // PATCH /api/admin/groups/:id — изменить название и режим реле
  app.patch('/admin/groups/:id', {
    onRequest: [authenticate, requireGroupAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          name:              { type: 'string', minLength: 1, maxLength: 100 },
          relay_duration_ms: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { name, relay_duration_ms } = req.body
    if (name !== undefined) {
      await db`UPDATE groups SET name = ${name}, updated_at = NOW() WHERE id = ${req.params.id}`
    }
    if (relay_duration_ms !== undefined) {
      await db`UPDATE groups SET relay_duration_ms = ${relay_duration_ms}, updated_at = NOW() WHERE id = ${req.params.id}`
    }
    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'update_group', 'group', ${req.params.id},
              ${JSON.stringify(req.body)})
    `
    return { ok: true }
  })

  // ── ПОЛЬЗОВАТЕЛИ ГРУППЫ ───────────────────────────────────────

  // GET /api/admin/groups/:groupId/users
  app.get('/admin/groups/:groupId/users', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req) => {
    const db = getDb()
    return db`
      SELECT u.id, u.login, u.display_name, u.phone, u.email,
             ug.role, ug.description, ug.created_at,
             u.single_session, u.must_change_password, u.is_active,
             u.created_by,
             EXISTS(
               SELECT 1 FROM refresh_tokens rt
               WHERE rt.user_id = u.id AND rt.expires_at > NOW()
             ) as has_session
      FROM users u
      JOIN user_groups ug ON ug.user_id = u.id
      WHERE ug.group_id = ${req.params.groupId}
      ORDER BY ug.role DESC, u.login
    `
  })

  // POST /api/admin/groups/:groupId/users — добавить пользователя
  // Два режима:
  //   1. Новый: { login, password, role, description, single_session }
  //   2. Существующий по ID: { user_id, description }
  app.post('/admin/groups/:groupId/users', {
    onRequest: [authenticate, requireGroupAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          // Режим 1: новый пользователь
          login:          { type: 'string', minLength: 3, maxLength: 100 },
          password:       { type: 'string', minLength: 6 },
          role:           { type: 'string', enum: ['user', 'admin'], default: 'user' },
          single_session: { type: 'boolean' },
          display_name:   { type: 'string', maxLength: 200 },
          phone:          { type: 'string', maxLength: 50 },
          email:          { type: 'string', maxLength: 200 },
          // Режим 2: существующий пользователь
          user_id:        { type: 'string', format: 'uuid' },
          // Общее
          description:    { type: 'string', maxLength: 500 },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const groupId = req.params.groupId
    const { login, password, role = 'user', description = null,
            user_id, display_name, phone, email } = req.body
    let { single_session } = req.body

    // Проверить квоту (только для пользователей)
    if (role === 'user') {
      const [group] = await db`SELECT user_quota FROM groups WHERE id = ${groupId}`
      if (group.user_quota > 0) {
        const [{ count }] = await db`
          SELECT COUNT(*) as count FROM user_groups ug
          WHERE ug.group_id = ${groupId} AND ug.role = 'user'
        `
        if (parseInt(count) >= group.user_quota) {
          return reply.code(403).send({
            error:   'quota_exceeded',
            message: `Достигнут лимит пользователей (${group.user_quota})`
          })
        }
      }
    }

    let targetUserId

    if (user_id) {
      // ── Режим 2: добавить существующего пользователя по ID ──
      const [existing] = await db`SELECT id, role FROM users WHERE id = ${user_id}`
      if (!existing) return reply.code(404).send({ error: 'user_not_found' })
      if (existing.role === 'superadmin') return reply.code(403).send({ error: 'forbidden' })
      targetUserId = user_id
    } else {
      // ── Режим 1: создать нового пользователя ────────────────
      if (!login || !password) {
        return reply.code(400).send({ error: 'login and password required' })
      }

      // Получить флаг создателя для определения single_session
      const [creator] = await db`SELECT single_session FROM users WHERE id = ${req.user.id}`

      if (role === 'user') {
        single_session = true  // пользователи всегда ограничены
      } else {
        // admin: если создатель ограничен — нельзя создать без ограничения
        if (creator.single_session) {
          single_session = true
        } else {
          single_session = single_session !== undefined ? single_session : true
        }
      }

      // Проверить что логин не занят
      const [taken] = await db`SELECT id FROM users WHERE login = ${login}`
      if (taken) return reply.code(409).send({ error: 'login_taken' })

      const newUser = await createUser(login, password, role, req.user.id, {
        must_change_password: true,
        single_session,
        display_name: display_name || null,
        phone:        phone || null,
        email:        email || null,
      })
      targetUserId = newUser.id
    }

    // Добавить в группу
    const [existing_membership] = await db`
      SELECT user_id FROM user_groups
      WHERE user_id = ${targetUserId} AND group_id = ${groupId}
    `
    if (existing_membership) {
      return reply.code(409).send({ error: 'already_in_group' })
    }

    await db`
      INSERT INTO user_groups (user_id, group_id, role, description, created_by)
      VALUES (${targetUserId}, ${groupId}, ${role}, ${description}, ${req.user.id})
    `

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, group_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'add_user_to_group', 'user', ${targetUserId},
              ${groupId}, ${JSON.stringify({ role, description, mode: user_id ? 'existing' : 'new' })})
    `

    return reply.code(201).send({ ok: true, userId: targetUserId })
  })

  // PATCH /api/admin/groups/:groupId/users/:userId — изменить описание
  app.patch('/admin/groups/:groupId/users/:userId', {
    onRequest: [authenticate, requireGroupAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          description: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { groupId, userId } = req.params

    await db`
      UPDATE user_groups SET description = ${req.body.description ?? null}
      WHERE group_id = ${groupId} AND user_id = ${userId}
    `
    return { ok: true }
  })

  // DELETE /api/admin/groups/:groupId/users/:userId
  // Удаляет из группы; триггер автоматически удаляет пользователя если нет других групп
  app.delete('/admin/groups/:groupId/users/:userId', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req, reply) => {
    const db = getDb()
    const { groupId, userId } = req.params

    // Нельзя удалить самого себя
    if (userId === req.user.id) {
      return reply.code(403).send({ error: 'cannot_remove_yourself' })
    }

    const [member] = await db`
      SELECT role FROM user_groups WHERE group_id = ${groupId} AND user_id = ${userId}
    `
    if (!member) return reply.code(404).send({ error: 'not_found' })

    await db`
      DELETE FROM user_groups WHERE group_id = ${groupId} AND user_id = ${userId}
    `
    // Триггер auto_delete_orphan_user сработает автоматически если нужно

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, group_id)
      VALUES (${req.user.id}, ${req.user.login}, 'remove_user_from_group', 'user', ${userId}, ${groupId})
    `
    return { ok: true }
  })

  // ── УПРАВЛЕНИЕ СЕССИЯМИ И ФЛАГАМИ ────────────────────────────

  // POST /api/admin/users/:userId/reset-sessions
  app.post('/admin/users/:userId/reset-sessions', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db = getDb()
    const targetId = req.params.userId

    // Проверить права доступа к пользователю
    await assertCanManageUser(req.user, targetId, db)

    await resetUserSessions(targetId, req.user.id)
    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id)
      VALUES (${req.user.id}, ${req.user.login}, 'reset_sessions', 'user', ${targetId})
    `
    return { ok: true }
  })

  // PATCH /api/admin/users/:userId/single-session
  app.patch('/admin/users/:userId/single-session', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')],
    schema: {
      body: {
        type: 'object',
        required: ['single_session'],
        properties: {
          single_session: { type: 'boolean' }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const targetId      = req.params.userId
    const { single_session } = req.body

    await assertCanManageUser(req.user, targetId, db)

    // Если сам ограничен — может управлять только своими пользователями
    // но не может СНЯТЬ ограничение (только установить)
    const [actor] = await db`SELECT single_session FROM users WHERE id = ${req.user.id}`
    if (actor.single_session && !single_session && req.user.role !== 'superadmin') {
      return reply.code(403).send({ error: 'cannot_remove_restriction' })
    }

    const [updated] = await db`
      UPDATE users SET single_session = ${single_session}, updated_at = NOW()
      WHERE id = ${targetId} AND role != 'superadmin'
      RETURNING id, login, single_session
    `
    if (!updated) return reply.code(404).send({ error: 'not_found' })

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'update_single_session', 'user', ${targetId},
              ${JSON.stringify({ single_session })})
    `
    return { ok: true, ...updated }
  })

  // ── УСТРОЙСТВА ESP ────────────────────────────────────────────

  // POST /api/admin/groups/:id/device-token — генерация кода привязки ESP
  app.post('/admin/groups/:id/device-token', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req, reply) => {
    const db = getDb()
    const groupId = req.params.id
    const code      = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

    await db`
      INSERT INTO device_tokens (group_id, code, expires_at, created_by)
      VALUES (${groupId}, ${code}, ${expiresAt}, ${req.user.id})
      ON CONFLICT (group_id) DO UPDATE
        SET code = ${code}, expires_at = ${expiresAt},
            created_by = ${req.user.id}, created_at = NOW()
    `
    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id)
      VALUES (${req.user.id}, ${req.user.login}, 'generate_device_token', 'group', ${groupId})
    `
    return { ok: true, code, expires_at: expiresAt }
  })

  // GET /api/admin/groups/:id/device — статус устройства группы
  app.get('/admin/groups/:id/device', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req) => {
    const db = getDb()
    const [device] = await db`
      SELECT d.device_id, d.fw_version, d.last_seen, d.registered_at,
             dg.relay_index,
             dt.code        as pending_code,
             dt.expires_at  as code_expires_at,
             CASE WHEN d.last_seen > NOW() - INTERVAL '2 minutes'
                  THEN true ELSE false END as is_online
      FROM groups g
      LEFT JOIN device_groups dg ON dg.group_id = g.id
      LEFT JOIN devices d ON d.device_id = dg.device_id
      LEFT JOIN device_tokens dt ON dt.group_id = g.id AND dt.expires_at > NOW()
      WHERE g.id = ${req.params.id}
      ORDER BY d.last_seen DESC NULLS LAST
      LIMIT 1
    `
    return device || { device_id: null, is_online: false }
  })

  // ── ЖУРНАЛ ────────────────────────────────────────────────────

  // GET /api/admin/groups/:groupId/logs
  app.get('/admin/groups/:groupId/logs', {
    onRequest: [authenticate, requireGroupAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', default: 50, maximum: 200 },
          offset: { type: 'integer', default: 0 }
        }
      }
    }
  }, async (req) => {
    const db = getDb()
    const { limit = 50, offset = 0 } = req.query
    return db`
      SELECT el.id, el.action, el.actor_login, el.target_type,
             el.target_id, el.payload, el.ip, el.ts
      FROM event_log el
      WHERE el.group_id = ${req.params.groupId}
      ORDER BY el.ts DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  })
}

// ── Вспомогательная: проверить что actor может управлять target ─
// Логика single_session:
//   superadmin     → может управлять всеми
//   admin без флага → может управлять всеми в своих группах + созданными им
//   admin с флагом  → только своими пользователями (created_by = actor.id)
async function assertCanManageUser(actor, targetId, db) {
  if (actor.role === 'superadmin') return

  // Проверить что target находится в одной из групп actor
  const [shared] = await db`
    SELECT ug2.user_id FROM user_groups ug1
    JOIN user_groups ug2 ON ug2.group_id = ug1.group_id
    WHERE ug1.user_id = ${actor.id} AND ug1.role = 'admin'
      AND ug2.user_id = ${targetId}
    LIMIT 1
  `

  if (!shared) {
    const err = new Error('forbidden')
    err.statusCode = 403
    throw err
  }

  // Если actor ограничен — может управлять только созданными им
  if (actor.single_session) {
    const [target] = await db`SELECT created_by FROM users WHERE id = ${targetId}`
    if (!target || target.created_by !== actor.id) {
      const err = new Error('forbidden')
      err.statusCode = 403
      throw err
    }
  }
}

module.exports = adminRoutes
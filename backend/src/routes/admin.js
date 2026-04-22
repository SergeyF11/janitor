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

  // POST /api/admin/users/:userId/password — смена пароля пользователя
  app.post('/admin/users/:userId/password', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')],
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
    const db       = getDb()
    const targetId = req.params.userId
    const { password } = req.body

    // Проверить права: только пользователи из своих групп
    await assertCanManageUser(req.user, targetId, db)

    const bcrypt = require('bcryptjs')
    const hash   = await bcrypt.hash(password, 10)
    await db`UPDATE users SET password_hash = ${hash} WHERE id = ${targetId}`

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, target_type, target_id)
      VALUES (${req.user.id}, ${req.user.login}, 'reset_password', 'user', ${targetId})
    `
    return { ok: true }
  })

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

  // POST /api/admin/groups/:id/trigger — управление реле (для администратора)
  // Body: { relay: 0 }  — индекс реле (опционально, по умолчанию 0)
  app.post('/admin/groups/:id/trigger', {
    onRequest: [authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          relay: { type: 'integer', minimum: 0, maximum: 7, default: 0 }
        }
      }
    }
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.id
    const relayIdx = req.body?.relay ?? 0

    await requireGroupAdmin(db, req.user, groupId)

    const [group] = await db`
      SELECT g.id, g.mqtt_topic, g.relay_duration_ms,
             d.device_id, d.mqtt_user
      FROM groups g
      LEFT JOIN devices d ON d.group_id = g.id
      WHERE g.id = ${groupId}
    `
    if (!group) return reply.code(404).send({ error: 'not_found' })

    // Прошивка ищет реле по имени — получаем имя из таблицы relays
    const [relayRow] = await db`
      SELECT name FROM relays
      WHERE device_id = ${group.device_id} AND relay_index = ${relayIdx}
    `
    const relayName = relayRow?.name || `Relay ${relayIdx + 1}`

    let mqttAction, newState
    if (group.relay_duration_ms === 0) {
      const [last] = await db`
        SELECT payload->>'state' as state FROM event_log
        WHERE group_id = ${groupId} AND action = 'relay_trigger'
        ORDER BY ts DESC LIMIT 1
      `
      newState   = last?.state === 'on' ? 'off' : 'on'
      mqttAction = { action: newState, relay: relayName }
    } else {
      newState   = 'pulse'
      mqttAction = { action: 'pulse', relay: relayName, duration: group.relay_duration_ms }
    }

    // Топик зависит от провайдера
    const provider = process.env.MQTT_PROVIDER || 'local'
    const topic = provider === 'yandex'
      ? `$devices/${group.mqtt_user}/commands`
      : `relay/${group.mqtt_topic}/cmd`

    try {
      const mqttClient = app.mqtt
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(topic, JSON.stringify(mqttAction), { qos: 1 })
        console.log(`[mqtt] → ${topic}: ${JSON.stringify(mqttAction)}`)
      }
    } catch (err) {
      console.error('[mqtt] publish error:', err.message)
    }

    await db`
      INSERT INTO event_log (actor_id, actor_login, action, group_id, payload)
      VALUES (${req.user.id}, ${req.user.login}, 'relay_trigger', ${groupId},
              ${JSON.stringify({ ...mqttAction, state: newState, topic, by: 'admin' })})
    `
    return { ok: true, state: newState, action: mqttAction }
  })

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
             d.is_online
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

  // ═══════════════════════════════════════════════════════════
  //  GSM — управление телефонной книгой и журналом
  // ═══════════════════════════════════════════════════════════
  // Все операции с телефонами проходят через MQTT → ESP → ответ через MQTT.
  // Номера телефонов НИКОГДА не хранятся в postgres.

  const { publishCommand, registerPending } = require('../mqtt/client')

  // Получить gsm_phone_idx для группы (список пользователей с телефонами)
  // GET /api/admin/groups/:groupId/gsm/phones
  app.get('/admin/groups/:groupId/gsm/phones', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    await assertAdminOwnsGroup(req.user, groupId, db)

    const rows = await db`
      SELECT gpi.id AS idx, gpi.user_id, gpi.relay_mask,
             u.login, u.display_name, gpi.created_at
      FROM gsm_phone_idx gpi
      JOIN users u ON u.id = gpi.user_id
      WHERE gpi.group_id = ${groupId}
      ORDER BY gpi.created_at
    `
    return rows
  })

  // Назначить телефон пользователю в группе — создаёт idx, отправляет на ESP
  // POST /api/admin/groups/:groupId/gsm/phones
  // body: { user_id, phone, relay_mask }
  app.post('/admin/groups/:groupId/gsm/phones', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')],
    schema: {
      body: {
        type: 'object', required: ['user_id', 'phone', 'relay_mask'],
        properties: {
          user_id:    { type: 'string', format: 'uuid' },
          phone:      { type: 'string', minLength: 10, maxLength: 15 },
          relay_mask: { type: 'integer', minimum: 1, maximum: 15 },
        }
      }
    }
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    const { user_id, phone, relay_mask } = req.body
    await assertAdminOwnsGroup(req.user, groupId, db)

    // Найти устройство группы
    const [device] = await db`
      SELECT d.device_id, d.mqtt_user, d.is_online
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device) return reply.code(404).send({ error: 'no_device' })

    // Создать запись в gsm_phone_idx
    const [row] = await db`
      INSERT INTO gsm_phone_idx (group_id, user_id, device_id, relay_mask)
      VALUES (${groupId}, ${user_id}, ${device.device_id}, ${relay_mask})
      ON CONFLICT (group_id, user_id, device_id)
        DO UPDATE SET relay_mask = ${relay_mask}
      RETURNING id
    `
    const idx = row.id

    // Отправить на ESP через MQTT
    const sent = publishCommand(device.mqtt_user, {
      action:     'set_phone',
      idx,
      phone,
      relays:     relay_mask,
    })

    if (!sent) {
      // Устройство оффлайн — сохранили idx, отправим при переподключении
      return { ok: true, idx, queued: true, warning: 'device_offline' }
    }

    // Ждём подтверждения от ESP (до 10 сек)
    try {
      const result = await registerPending(device.device_id, 'set_phone', 10000)
      return { ok: result.ok, idx, confirmed: true }
    } catch {
      return { ok: true, idx, confirmed: false, warning: 'no_confirm' }
    }
  })

  // Обновить телефон/маску реле
  // PATCH /api/admin/groups/:groupId/gsm/phones/:idx
  // body: { phone?, relay_mask? }
  app.patch('/admin/groups/:groupId/gsm/phones/:idx', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')],
    schema: {
      body: {
        type: 'object',
        properties: {
          phone:      { type: 'string', minLength: 10, maxLength: 15 },
          relay_mask: { type: 'integer', minimum: 1, maximum: 15 },
        }
      }
    }
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    const idx     = parseInt(req.params.idx)
    const { phone, relay_mask } = req.body
    await assertAdminOwnsGroup(req.user, groupId, db)

    if (relay_mask != null) {
      await db`
        UPDATE gsm_phone_idx SET relay_mask = ${relay_mask}
        WHERE id = ${idx} AND group_id = ${groupId}
      `
    }

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device) return reply.code(404).send({ error: 'no_device' })

    const sent = publishCommand(device.mqtt_user, {
      action:     'set_phone',
      idx,
      ...(phone      ? { phone }      : {}),
      ...(relay_mask ? { relays: relay_mask } : {}),
    })

    return { ok: true, queued: !sent }
  })

  // Удалить телефон пользователя
  // DELETE /api/admin/groups/:groupId/gsm/phones/:idx
  app.delete('/admin/groups/:groupId/gsm/phones/:idx', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    const idx     = parseInt(req.params.idx)
    await assertAdminOwnsGroup(req.user, groupId, db)

    await db`DELETE FROM gsm_phone_idx WHERE id = ${idx} AND group_id = ${groupId}`

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user FROM devices d WHERE d.group_id = ${groupId}
    `
    if (device) {
      publishCommand(device.mqtt_user, { action: 'del_phone', idx })
    }

    return { ok: true }
  })

  // Запросить номер телефона пользователя (номер хранится только на ESP!)
  // GET /api/admin/groups/:groupId/gsm/phones/:idx/number
  app.get('/admin/groups/:groupId/gsm/phones/:idx/number', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    const idx     = parseInt(req.params.idx)
    await assertAdminOwnsGroup(req.user, groupId, db)

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user, d.is_online
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device)          return reply.code(404).send({ error: 'no_device' })
    if (!device.is_online) return reply.code(503).send({ error: 'device_offline' })

    publishCommand(device.mqtt_user, { action: 'get_phone', idx })

    try {
      const result = await registerPending(device.device_id, 'phone_response', 10000)
      return result
    } catch {
      return reply.code(504).send({ error: 'timeout' })
    }
  })

  // Получить журнал SMS с ESP
  // GET /api/admin/groups/:groupId/gsm/sms-journal?max=10
  app.get('/admin/groups/:groupId/gsm/sms-journal', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    const max     = Math.min(parseInt(req.query.max || '10'), 32)
    await assertAdminOwnsGroup(req.user, groupId, db)

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user, d.is_online
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device)           return reply.code(404).send({ error: 'no_device' })
    if (!device.is_online) return reply.code(503).send({ error: 'device_offline' })

    publishCommand(device.mqtt_user, { action: 'get_sms_journal', max })

    try {
      const result = await registerPending(device.device_id, 'sms_journal', 10000)
      return result
    } catch {
      return reply.code(504).send({ error: 'timeout' })
    }
  })

  // Отправить SMS (ответ на операторский)
  // POST /api/admin/groups/:groupId/gsm/send-sms
  // body: { to, text, journal_idx? }
  app.post('/admin/groups/:groupId/gsm/send-sms', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')],
    schema: {
      body: {
        type: 'object', required: ['to', 'text'],
        properties: {
          to:          { type: 'string', minLength: 3, maxLength: 20 },
          text:        { type: 'string', minLength: 1, maxLength: 160 },
          journal_idx: { type: 'integer' },
        }
      }
    }
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    await assertAdminOwnsGroup(req.user, groupId, db)

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user, d.is_online
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device)           return reply.code(404).send({ error: 'no_device' })
    if (!device.is_online) return reply.code(503).send({ error: 'device_offline' })

    publishCommand(device.mqtt_user, {
      action:      'send_sms',
      ...req.body,
    })

    return { ok: true }
  })

  // Очистить журнал SMS на ESP
  // DELETE /api/admin/groups/:groupId/gsm/sms-journal
  app.delete('/admin/groups/:groupId/gsm/sms-journal', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    await assertAdminOwnsGroup(req.user, groupId, db)

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device) return reply.code(404).send({ error: 'no_device' })

    publishCommand(device.mqtt_user, { action: 'clear_sms_journal' })
    return { ok: true }
  })

  // Запросить GSM-статус
  // GET /api/admin/groups/:groupId/gsm/status
  app.get('/admin/groups/:groupId/gsm/status', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    await assertAdminOwnsGroup(req.user, groupId, db)

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user, d.gsm_status, d.is_online
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device) return reply.code(404).send({ error: 'no_device' })

    // Возвращаем кэшированный статус из БД — живой запрос через WS
    return {
      is_online:  device.is_online,
      gsm_status: device.gsm_status || null,
    }
  })

  // Скачать бэкап БД телефонов (бинарный base64)
  // GET /api/admin/groups/:groupId/gsm/backup
  app.get('/admin/groups/:groupId/gsm/backup', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    await assertAdminOwnsGroup(req.user, groupId, db)

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user, d.is_online
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device)           return reply.code(404).send({ error: 'no_device' })
    if (!device.is_online) return reply.code(503).send({ error: 'device_offline' })

    publishCommand(device.mqtt_user, { action: 'backup_db' })

    try {
      // Ждём все чанки (до 30 сек — бэкап может быть большим)
      const result = await registerPending(device.device_id, 'backup_db', 30000)
      if (!result.ok) return reply.code(500).send({ error: 'backup_failed' })

      // Возвращаем как бинарный файл
      const buf = Buffer.from(result.data, 'base64')
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition',
        `attachment; filename="phonebook_${device.device_id}_${Date.now()}.jdb"`)
      return reply.send(buf)
    } catch {
      return reply.code(504).send({ error: 'timeout' })
    }
  })

  // Восстановить БД телефонов из файла
  // POST /api/admin/groups/:groupId/gsm/restore
  // multipart: file=*.jdb
  app.post('/admin/groups/:groupId/gsm/restore', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    await assertAdminOwnsGroup(req.user, groupId, db)

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user, d.is_online
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device)           return reply.code(404).send({ error: 'no_device' })
    if (!device.is_online) return reply.code(503).send({ error: 'device_offline' })

    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'no_file' })

    const buf    = await data.toBuffer()
    const b64    = buf.toString('base64')
    const CHUNK  = 384
    const chunks = []
    for (let i = 0; i < b64.length; i += CHUNK)
      chunks.push(b64.slice(i, i + CHUNK))

    const total = chunks.length
    for (let seq = 0; seq < total; seq++) {
      publishCommand(device.mqtt_user, {
        action: 'restore_db_chunk',
        seq, total,
        data: chunks[seq],
      })
      await new Promise(r => setTimeout(r, 100))  // пауза между чанками
    }

    try {
      const result = await registerPending(device.device_id, 'restore_db', 30000)
      return { ok: result.ok }
    } catch {
      return reply.code(504).send({ error: 'timeout' })
    }
  })

  // Запустить компактификацию БД
  // POST /api/admin/groups/:groupId/gsm/compact
  app.post('/admin/groups/:groupId/gsm/compact', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db      = getDb()
    const groupId = req.params.groupId
    await assertAdminOwnsGroup(req.user, groupId, db)

    const [device] = await db`
      SELECT d.device_id, d.mqtt_user, d.is_online
      FROM devices d WHERE d.group_id = ${groupId}
    `
    if (!device)           return reply.code(404).send({ error: 'no_device' })
    if (!device.is_online) return reply.code(503).send({ error: 'device_offline' })

    publishCommand(device.mqtt_user, { action: 'trigger_compaction' })
    return { ok: true }
  })

} // end adminRoutes

// ── Проверка что admin владеет группой ───────────────────────
async function assertAdminOwnsGroup(actor, groupId, db) {
  if (actor.role === 'superadmin') return
  const [row] = await db`
    SELECT 1 FROM user_groups
    WHERE user_id = ${actor.id} AND group_id = ${groupId} AND role = 'admin'
  `
  if (!row) {
    const err = new Error('forbidden'); err.statusCode = 403; throw err
  }
}

// ── Проверка что admin может управлять пользователем ─────────
async function assertCanManageUser(actor, targetId, db) {
  if (actor.role === 'superadmin') return

  const [shared] = await db`
    SELECT ug2.user_id FROM user_groups ug1
    JOIN user_groups ug2 ON ug2.group_id = ug1.group_id
    WHERE ug1.user_id = ${actor.id} AND ug1.role = 'admin'
      AND ug2.user_id = ${targetId}
    LIMIT 1
  `
  if (!shared) {
    const err = new Error('forbidden'); err.statusCode = 403; throw err
  }

  if (actor.single_session) {
    const [target] = await db`SELECT created_by FROM users WHERE id = ${targetId}`
    if (!target || target.created_by !== actor.id) {
      const err = new Error('forbidden'); err.statusCode = 403; throw err
    }
  }
}

module.exports = adminRoutes
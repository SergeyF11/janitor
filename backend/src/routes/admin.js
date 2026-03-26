'use strict'
const { getDb } = require('../db/connection')
const { createUser, resetUserSessions, authenticate, requireRole } = require('../services/auth.service')
const provider = require('../mqtt/provider')

async function requireGroupAdmin(req, reply) {
  const db = getDb()
  const groupId = req.params.groupId || req.params.id
  if (!groupId) return reply.code(400).send({ error: 'groupId required' })
  if (req.user.role === 'superadmin') return
  const [m] = await db`
    SELECT role FROM user_groups
    WHERE user_id = ${req.user.id} AND group_id = ${groupId}
  `
  if (!m || m.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
}

async function adminRoutes(app) {

  // ── ГРУППЫ ───────────────────────────────────────────────────

  app.get('/admin/groups', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req) => {
    const db = getDb()
    return db`
      SELECT g.id, g.name, g.mqtt_topic, g.status, g.expires_at, g.grace_until, g.user_quota,
             COUNT(ug2.user_id) FILTER (WHERE ug2.role = 'user') AS user_count,
             d.device_id, COALESCE(d.is_online, false) AS is_online, d.fw_version, d.last_seen
      FROM groups g
      JOIN user_groups ug ON ug.group_id = g.id AND ug.user_id = ${req.user.id} AND ug.role = 'admin'
      WHERE g.status IN ('active', 'blocked')
      LEFT JOIN user_groups ug2 ON ug2.group_id = g.id
      LEFT JOIN devices d ON d.group_id = g.id
      GROUP BY g.id, d.device_id, COALESCE(d.is_online, false) AS is_online, d.fw_version, d.last_seen
      ORDER BY g.name
    `
  })

  app.patch('/admin/groups/:id', {
    onRequest: [authenticate, requireGroupAdmin],
    schema: {
      body: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } }
    }
  }, async (req) => {
    const db = getDb()
    if (req.body.name !== undefined) {
      await db`UPDATE groups SET name = ${req.body.name}, updated_at = NOW() WHERE id = ${req.params.id}`
    }
    return { ok: true }
  })

  // ── РЕЛЕ ─────────────────────────────────────────────────────

  app.get('/admin/groups/:id/relays', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req) => {
    const db = getDb()
    return db`
      SELECT r.id, r.relay_index, r.name, r.duration_ms, r.last_state, r.last_state_at
      FROM relays r
      JOIN devices d ON d.device_id = r.device_id
      WHERE d.group_id = ${req.params.id}
      ORDER BY r.relay_index
    `
  })

  app.patch('/admin/relays/:relayId', {
    onRequest: [authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name:        { type: 'string', minLength: 1, maxLength: 100 },
          duration_ms: { type: 'integer', minimum: 0 },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const [relay] = await db`
      SELECT r.id, d.group_id FROM relays r
      JOIN devices d ON d.device_id = r.device_id
      WHERE r.id = ${req.params.relayId}
    `
    if (!relay) return reply.code(404).send({ error: 'not_found' })

    if (req.user.role !== 'superadmin') {
      const [m] = await db`SELECT role FROM user_groups WHERE user_id = ${req.user.id} AND group_id = ${relay.group_id}`
      if (!m || m.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
    }

    const { name, duration_ms } = req.body
    if (name        !== undefined) await db`UPDATE relays SET name = ${name} WHERE id = ${req.params.relayId}`
    if (duration_ms !== undefined) await db`UPDATE relays SET duration_ms = ${duration_ms} WHERE id = ${req.params.relayId}`
    return { ok: true }
  })

app.post('/admin/relays/:relayId/trigger', {
    onRequest: [authenticate]
  }, async (req, reply) => {
    const db = getDb()
    const [relay] = await db`
      SELECT r.id, r.name, r.duration_ms, r.device_id, r.last_state,
             d.mqtt_user, d.mqtt_password, d.group_id, d.is_online,
             g.mqtt_topic, g.status, g.expires_at, g.grace_until
      FROM relays r
      JOIN devices d ON d.device_id = r.device_id
      JOIN groups g ON g.id = d.group_id
      WHERE r.id = ${req.params.relayId}
    `
    if (!relay) return reply.code(404).send({ error: 'not_found' })

    if (req.user.role !== 'superadmin') {
      const [m] = await db`SELECT role FROM user_groups WHERE user_id = ${req.user.id} AND group_id = ${relay.group_id}`
      if (!m || m.role !== 'admin') return reply.code(403).send({ error: 'forbidden' })
    }

    // Проверка: группа заблокирована или истёк льготный период
    const now = new Date()
    const graceUntil = relay.grace_until ? new Date(relay.grace_until) : null
    const expiresAt  = relay.expires_at  ? new Date(relay.expires_at)  : null
    const blocked = relay.status === 'blocked'
      || (expiresAt && expiresAt < now && (!graceUntil || graceUntil < now))
    if (blocked) {
      await db`
        INSERT INTO event_log (action, actor_id, actor_login, group_id, relay_id, payload, ip)
        VALUES ('relay_trigger_blocked', ${req.user.id}, ${req.user.login},
                ${relay.group_id}, ${relay.id},
                ${{ relay: relay.name, reason: 'group_blocked', by: 'admin' }}, ${req.ip})
      `
      return reply.code(403).send({ error: 'group_blocked' })
    }

    if (!relay.is_online) return reply.code(503).send({ error: 'device_offline' })

    let action, newState
    if (relay.duration_ms === 0) {
      newState = relay.last_state === 'on' ? 'off' : 'on'
      action   = newState
    } else {
      newState = 'pulse'
      action   = 'pulse'
    }

    console.log(`[admin] relay ${relay.id} last_state=${relay.last_state}, newState=${newState}`);
    
    const cmd   = { relay: relay.name, action, ...(action === 'pulse' ? { duration: relay.duration_ms } : {}) }
    const topic = `$devices/${relay.mqtt_user}/commands`

    const mqttClient = app.mqtt
    if (!mqttClient?.connected) return reply.code(503).send({ error: 'mqtt_unavailable' })
    await provider.ensureDeviceAccess?.({
      deviceId: relay.device_id,
      mqttUser: relay.mqtt_user,
      mqttPass: relay.mqtt_password,
      mqttTopic: relay.mqtt_topic,
    })
    mqttClient.publish(topic, JSON.stringify(cmd), { qos: 1 })
    console.log( `[mqtt publish] ${topic}:${cmd}`);

    await db`
      INSERT INTO event_log (action, actor_id, actor_login, group_id, relay_id, payload)
      VALUES ('relay_trigger', ${req.user.id}, ${req.user.login},
              ${relay.group_id}, ${relay.id},
              ${ {relay: relay.name, action, state: newState, by: 'admin'} })
    `
    return { ok: true, state: newState }
  })

  // ── ПОЛЬЗОВАТЕЛИ ГРУППЫ ───────────────────────────────────────

  app.get('/admin/groups/:groupId/users', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req) => {
    const db = getDb()
    const groupId = req.params.groupId

    return db`
      SELECT
        u.id,
        u.login,
        u.role AS global_role,
        u.single_session,
        u.must_change_password,
        u.is_active,
        ug.description,
        ug.role AS group_role,
        EXISTS(SELECT 1 FROM refresh_tokens rt WHERE rt.user_id = u.id AND rt.expires_at > NOW()) AS has_session,
        g_reg.mqtt_topic AS registration_topic
      FROM users u
      JOIN user_groups ug ON ug.user_id = u.id
      LEFT JOIN groups g_reg ON g_reg.id = u.registration_group_id
      WHERE ug.group_id = ${groupId}
      ORDER BY ug.role DESC, u.login
    `
  })

  // create user
  app.post('/admin/groups/:groupId/users', {
    onRequest: [authenticate, requireGroupAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          login:          { type: 'string', minLength: 3, maxLength: 100 },
          password:       { type: 'string', minLength: 6 },
          role:           { type: 'string', enum: ['user', 'admin'], default: 'user' },
          single_session: { type: 'boolean' },
          display_name:   { type: 'string', maxLength: 200 },
          phone:          { type: 'string', maxLength: 50 },
          description:    { type: 'string', maxLength: 500 },
          user_id:        { type: 'string', format: 'uuid' },
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const groupId = req.params.groupId
    const { login, password, role = 'user', description = null,
            user_id, display_name, phone } = req.body
    let { single_session } = req.body

    // Проверка квоты на общее количество участников группы
    const [group] = await db`SELECT user_quota FROM groups WHERE id = ${groupId}`
    if (group?.user_quota > 0) {
      const [{ count }] = await db`
        SELECT COUNT(*) AS count FROM user_groups WHERE group_id = ${groupId}
      `
      if (parseInt(count) >= group.user_quota) {
        return reply.code(403).send({ error: 'quota_exceeded' })
      }
    }

    // Определяем, должен ли пользователь быть single_session
    const [creator] = await db`SELECT single_session FROM users WHERE id = ${req.user.id}`
    const forceSingleSession = creator?.single_session === true

    let targetUserId
    let globalRole // будет определена позже

    if (user_id) {
      // Добавление существующего пользователя по ID
      const [existing] = await db`
        SELECT id, role, single_session FROM users WHERE id = ${user_id}
      `
      if (!existing) return reply.code(404).send({ error: 'user_not_found' })
      if (existing.role === 'superadmin') return reply.code(403).send({ error: 'forbidden' })

      // Проверяем, не состоит ли уже в группе
      const [inGroup] = await db`
        SELECT 1 FROM user_groups WHERE user_id = ${user_id} AND group_id = ${groupId}
      `
      if (inGroup) return reply.code(409).send({ error: 'already_in_group' })

      targetUserId = user_id
      globalRole = existing.role

      // Если добавляем как администратора, а глобальная роль user, повышаем до admin
      if (role === 'admin' && globalRole === 'user') {
        await db`UPDATE users SET role = 'admin' WHERE id = ${targetUserId}`
        globalRole = 'admin'
      }
    } else {
      // Создание нового пользователя
      if (!login || !password) return reply.code(400).send({ error: 'login_and_password_required' })

      // Проверяем уникальность логина в группе регистрации (текущая группа)
      const [taken] = await db`
        SELECT id FROM users WHERE login = ${login} AND registration_group_id = ${groupId}
      `
      if (taken) return reply.code(409).send({ error: 'login_taken_in_group' })

      // Создаём пользователя с registration_group_id = текущая группа
      const newUser = await createUser(
        login,
        password,
        role, // глобальная роль совпадает с запрашиваемой
        req.user.id,
        groupId, // registration_group_id
        {
          must_change_password: true,
          single_session: (role === 'user' || forceSingleSession) ? true : (single_session ?? true),
          display_name: display_name || null,
          phone: phone || null,
        }
      )
      targetUserId = newUser.id
      globalRole = role
    }

    // Добавляем запись в user_groups
    await db`
      INSERT INTO user_groups (user_id, group_id, description, role, created_by)
      VALUES (${targetUserId}, ${groupId}, ${description}, ${role}, ${req.user.id})
    `

    return reply.code(201).send({ ok: true, userId: targetUserId })
  })

  // delete user
  app.delete('/admin/groups/:groupId/users/:userId', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req, reply) => {
    if (req.params.userId === req.user.id) {
      return reply.code(403).send({ error: 'cannot_remove_yourself' })
    }
    const db = getDb()
    const groupId = req.params.groupId
    const userId = req.params.userId

    // Узнаём роль пользователя в этой группе
    const [ug] = await db`
      SELECT role FROM user_groups WHERE group_id = ${groupId} AND user_id = ${userId}
    `
    if (!ug) return reply.code(404).send({ error: 'not_found' })

    await db`DELETE FROM user_groups WHERE group_id = ${groupId} AND user_id = ${userId}`

    // Проверяем, остались ли у пользователя другие группы
    const [otherGroups] = await db`
      SELECT COUNT(*) AS count FROM user_groups WHERE user_id = ${userId}
    `
    if (parseInt(otherGroups.count) === 0) {
      // Пользователь больше не состоит ни в одной группе — удаляем его (если не суперадмин)
      await db`DELETE FROM users WHERE id = ${userId} AND role != 'superadmin'`
    } else {
      // Если удаляли из группы, где он был админом, и других групп с ролью admin у него не осталось,
      // понижаем глобальную роль до user
      if (ug.role === 'admin') {
        const [adminGroups] = await db`
          SELECT COUNT(*) AS count FROM user_groups WHERE user_id = ${userId} AND role = 'admin'
        `
        if (parseInt(adminGroups.count) === 0) {
          await db`UPDATE users SET role = 'user' WHERE id = ${userId}`
        }
      }
    }

    return { ok: true }
  })

  app.patch('/admin/groups/:groupId/users/:userId', {
    onRequest: [authenticate, requireGroupAdmin],
    schema: { body: { type: 'object', properties: { description: { type: 'string', maxLength: 500 } } } }
  }, async (req) => {
    const db = getDb()
    await db`UPDATE user_groups SET description = ${req.body.description ?? null}
             WHERE group_id = ${req.params.groupId} AND user_id = ${req.params.userId}`
    return { ok: true }
  })

  // ── УСТРОЙСТВО ESP ────────────────────────────────────────────

  app.post('/admin/groups/:id/device-token', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req) => {
    const db        = getDb()
    const groupId   = req.params.id
    const code      = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await db`
      INSERT INTO device_tokens (group_id, code, expires_at, created_by)
      VALUES (${groupId}, ${code}, ${expiresAt}, ${req.user.id})
      ON CONFLICT (group_id) DO UPDATE
        SET code = ${code}, expires_at = ${expiresAt}, created_by = ${req.user.id}, created_at = NOW()
    `
    return { ok: true, code, expires_at: expiresAt }
  })

  app.get('/admin/groups/:id/device', {
    onRequest: [authenticate, requireGroupAdmin]
  }, async (req) => {
    const db = getDb()
    const [device] = await db`
      SELECT d.device_id, d.fw_version, d.last_seen, d.registered_at,
             COALESCE(d.is_online, false) AS is_online,
             dt.code AS pending_code, dt.expires_at AS code_expires_at
      FROM groups g
      LEFT JOIN devices d ON d.group_id = g.id
      LEFT JOIN device_tokens dt ON dt.group_id = g.id AND dt.expires_at > NOW()
      WHERE g.id = ${req.params.id}
      LIMIT 1
    `
    if (!device?.device_id) {
      return { device_id: null, is_online: false, pending_code: device?.pending_code || null }
    }
    const relays = await db`
      SELECT id, relay_index, name, duration_ms, last_state
      FROM relays WHERE device_id = ${device.device_id}
      ORDER BY relay_index
    `
    return { ...device, relays }
  })

  // ── СЕССИИ / ПАРОЛЬ / ФЛАГИ ───────────────────────────────────

  // Сброс сессий пользователя (администратор группы)
  app.post('/admin/users/:userId/reset-sessions', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')]
  }, async (req, reply) => {
    const db = getDb()
    const { groupId } = req.query // ожидаем groupId в query
    if (!groupId) return reply.code(400).send({ error: 'groupId required' })
    await assertCanManageUser(req.user, req.params.userId, groupId, db)
    await resetUserSessions(req.params.userId, req.user.id)
    return { ok: true }
  })

  // Смена пароля пользователя (администратор группы)
  app.post('/admin/users/:userId/password', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')],
    schema: { body: { type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 6 } } } }
  }, async (req, reply) => {
    const db = getDb()
    const { groupId } = req.query
    if (!groupId) return reply.code(400).send({ error: 'groupId required' })
    await assertCanManageUser(req.user, req.params.userId, groupId, db)
    const bcrypt = require('bcryptjs')
    await db`UPDATE users SET password_hash = ${await bcrypt.hash(req.body.password, 10)} WHERE id = ${req.params.userId}`
    return { ok: true }
  })

  // Изменение флага single_session (администратор группы)
  app.patch('/admin/users/:userId/single-session', {
    onRequest: [authenticate, requireRole('admin', 'superadmin')],
    schema: { body: { type: 'object', required: ['single_session'], properties: { single_session: { type: 'boolean' } } } }
  }, async (req, reply) => {
    const db = getDb()
    const { groupId } = req.query
    if (!groupId) return reply.code(400).send({ error: 'groupId required' })
    await assertCanManageUser(req.user, req.params.userId, groupId, db)

    const [actor] = await db`SELECT single_session FROM users WHERE id = ${req.user.id}`
    if (actor.single_session && !req.body.single_session && req.user.role !== 'superadmin') {
      return reply.code(403).send({ error: 'cannot_remove_restriction' })
    }
    await db`UPDATE users SET single_session = ${req.body.single_session}, updated_at = NOW()
            WHERE id = ${req.params.userId} AND role != 'superadmin'`
    return { ok: true }
  })

  // ── ЖУРНАЛ ────────────────────────────────────────────────────

  app.get('/admin/groups/:groupId/logs', {
    onRequest: [authenticate, requireGroupAdmin],
    schema: { querystring: { type: 'object', properties: {
      limit:  { type: 'integer', default: 50, maximum: 200 },
      offset: { type: 'integer', default: 0 }
    }}}
  }, async (req) => {
    const db = getDb()
    const { limit = 50, offset = 0 } = req.query
    return db`
      SELECT el.id, el.action, el.actor_login,
             el.payload,
             el.ts,
             r.name AS relay_name
      FROM event_log el
      LEFT JOIN relays r ON r.id = el.relay_id
      WHERE el.group_id = ${req.params.groupId}
      ORDER BY el.ts DESC LIMIT ${limit} OFFSET ${offset}
    `
  })

  // ── ИМПОРТ ПОЛЬЗОВАТЕЛЕЙ ──────────────────────────────────────
app.post('/admin/groups/:groupId/import-from/:sourceGroupId', {
  onRequest: [authenticate, requireGroupAdmin]
}, async (req, reply) => {
  const db = getDb()
  const targetGroupId = req.params.groupId
  const sourceGroupId = req.params.sourceGroupId

  const [targetGroup] = await db`SELECT user_quota FROM groups WHERE id = ${targetGroupId}`
  if (!targetGroup) return reply.code(404).send({ error: 'group_not_found' })

  const [{ count: currentCount }] = await db`
    SELECT COUNT(*) AS count FROM user_groups WHERE group_id = ${targetGroupId}
  `

  let added = 0, quotaSkipped = 0
  for (const su of sourceUsers) {
    const [exists] = await db`
      SELECT 1 FROM user_groups WHERE group_id = ${targetGroupId} AND user_id = ${su.user_id}
    `
    if (exists) continue

    if (targetGroup.user_quota > 0 && (parseInt(currentCount) + added) >= targetGroup.user_quota) {
      quotaSkipped++
      continue
    }

    await db`
      INSERT INTO user_groups (user_id, group_id, description, role, created_by)
      VALUES (${su.user_id}, ${targetGroupId}, ${su.description || null}, ${su.role}, ${req.user.id})
    `
    added++
  }

  return { ok: true, added, quotaSkipped }
})
}

async function assertCanManageUser(actor, targetId, groupId, db) {
  if (actor.role === 'superadmin') return
  // Проверяем, что actor является админом в указанной группе
  const [admin] = await db`
    SELECT 1 FROM user_groups
    WHERE user_id = ${actor.id} AND group_id = ${groupId} AND role = 'admin'
  `
  if (!admin) { const e = new Error('forbidden'); e.statusCode = 403; throw e }
  // Проверяем, что target состоит в этой группе (не обязательно админ)
  const [target] = await db`
    SELECT 1 FROM user_groups WHERE user_id = ${targetId} AND group_id = ${groupId}
  `
  if (!target) { const e = new Error('user_not_in_group'); e.statusCode = 404; throw e }
}

module.exports = adminRoutes
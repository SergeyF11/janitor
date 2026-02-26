'use strict'

const { getDb } = require('../db/connection')
const { createUser } = require('../services/auth.service')

// Middleware: проверить что пользователь — admin данной группы
async function requireGroupAdmin(req, reply) {
  const db = getDb()
  const groupId = req.params.groupId || req.params.id
  if (!groupId) return reply.code(400).send({ error: 'groupId required' })

  const [m] = await db`
    SELECT role FROM user_groups
    WHERE user_id = ${req.user.id} AND group_id = ${groupId}
  `
  if (!m || m.role !== 'admin') {
    return reply.code(403).send({ error: 'Admin access required for this group' })
  }
}

async function adminRoutes(app) {

  // GET /api/admin/groups — мои группы где я админ
  app.get('/admin/groups', {
    onRequest: [app.authenticate]
  }, async (req, reply) => {
    const db = getDb()
    return db`
      SELECT g.id, g.name, g.mqtt_topic, g.relay_duration_ms
      FROM groups g
      JOIN user_groups ug ON ug.group_id = g.id
      WHERE ug.user_id = ${req.user.id} AND ug.role = 'admin'
      ORDER BY g.name
    `
  })

  // GET /api/admin/groups/:groupId/users — пользователи группы
  app.get('/admin/groups/:groupId/users', {
    onRequest: [app.authenticate, requireGroupAdmin]
  }, async (req, reply) => {
    const db = getDb()
    return db`
      SELECT u.id, u.login, ug.role, ug.created_at
      FROM users u
      JOIN user_groups ug ON ug.user_id = u.id
      WHERE ug.group_id = ${req.params.groupId}
      ORDER BY ug.role, u.login
    `
  })

  // POST /api/admin/groups/:groupId/users — добавить пользователя в группу
  app.post('/admin/groups/:groupId/users', {
    onRequest: [app.authenticate, requireGroupAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['login', 'password'],
        properties: {
          login:    { type: 'string', minLength: 3, maxLength: 100 },
          password: { type: 'string', minLength: 6 },
          role:     { type: 'string', enum: ['user', 'admin'], default: 'user' }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { login, password, role = 'user' } = req.body
    const groupId = req.params.groupId

    // Пользователь уже существует?
    let [user] = await db`SELECT id FROM users WHERE login = ${login}`

    if (!user) {
      // Создать нового пользователя
      user = await createUser(login, password, 'user', req.user.id)
    }

    // Добавить в группу (или обновить роль)
    await db`
      INSERT INTO user_groups (user_id, group_id, role, created_by)
      VALUES (${user.id}, ${groupId}, ${role}, ${req.user.id})
      ON CONFLICT (user_id, group_id) DO UPDATE SET role = ${role}
    `

    // Журнал администрирования
    await db`
      INSERT INTO admin_log (actor_id, action, target_type, target_id, payload)
      VALUES (${req.user.id}, 'add_user_to_group', 'user', ${user.id},
              ${JSON.stringify({ groupId, login, role })})
    `

    return reply.code(201).send({ ok: true, userId: user.id })
  })

  // DELETE /api/admin/groups/:groupId/users/:userId — удалить пользователя из группы
  app.delete('/admin/groups/:groupId/users/:userId', {
    onRequest: [app.authenticate, requireGroupAdmin]
  }, async (req, reply) => {
    const db = getDb()
    await db`
      DELETE FROM user_groups
      WHERE group_id = ${req.params.groupId} AND user_id = ${req.params.userId}
    `
    await db`
      INSERT INTO admin_log (actor_id, action, target_type, target_id)
      VALUES (${req.user.id}, 'remove_user_from_group', 'user', ${req.params.userId})
    `
    return { ok: true }
  })

  // GET /api/admin/groups/:groupId/logs — журнал событий группы
  app.get('/admin/groups/:groupId/logs', {
    onRequest: [app.authenticate, requireGroupAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', default: 50, maximum: 200 },
          offset: { type: 'integer', default: 0 }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { limit, offset } = req.query
    return db`
      SELECT el.id, el.action, el.source, el.ts,
             u.login as user_login
      FROM event_log el
      LEFT JOIN users u ON u.id = el.user_id
      WHERE el.group_id = ${req.params.groupId}
      ORDER BY el.ts DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  })
}

module.exports = adminRoutes

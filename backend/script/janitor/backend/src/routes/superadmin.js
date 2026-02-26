'use strict'

const { getDb } = require('../db/connection')
const { createUser } = require('../services/auth.service')

// Middleware: только суперадмин
async function requireSuperAdmin(req, reply) {
  if (req.user.role !== 'superadmin') {
    return reply.code(403).send({ error: 'Superadmin access required' })
  }
}

async function superadminRoutes(app) {

  // GET /api/sa/admins — список администраторов
  app.get('/sa/admins', {
    onRequest: [app.authenticate, requireSuperAdmin]
  }, async (req, reply) => {
    const db = getDb()
    return db`
      SELECT id, login, created_at FROM users
      WHERE role IN ('admin', 'superadmin')
      ORDER BY created_at DESC
    `
  })

  // POST /api/sa/admins — создать администратора
  app.post('/sa/admins', {
    onRequest: [app.authenticate, requireSuperAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['login', 'password'],
        properties: {
          login:    { type: 'string', minLength: 3, maxLength: 100 },
          password: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { login, password } = req.body
    const user = await createUser(login, password, 'admin', req.user.id)

    await db`
      INSERT INTO admin_log (actor_id, action, target_type, target_id)
      VALUES (${req.user.id}, 'create_admin', 'user', ${user.id})
    `

    return reply.code(201).send(user)
  })

  // GET /api/sa/groups — все группы
  app.get('/sa/groups', {
    onRequest: [app.authenticate, requireSuperAdmin]
  }, async (req, reply) => {
    const db = getDb()
    return db`
      SELECT g.id, g.name, g.mqtt_topic, g.relay_duration_ms,
             COUNT(ug.user_id) as member_count
      FROM groups g
      LEFT JOIN user_groups ug ON ug.group_id = g.id
      GROUP BY g.id
      ORDER BY g.name
    `
  })

  // POST /api/sa/groups — создать группу
  app.post('/sa/groups', {
    onRequest: [app.authenticate, requireSuperAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'mqtt_topic'],
        properties: {
          name:              { type: 'string', minLength: 1, maxLength: 100 },
          mqtt_topic:        { type: 'string', minLength: 1, maxLength: 200 },
          relay_duration_ms: { type: 'integer', minimum: 0, default: 500 },
          admin_id:          { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { name, mqtt_topic, relay_duration_ms = 500, admin_id } = req.body

    const [group] = await db`
      INSERT INTO groups (name, mqtt_topic, relay_duration_ms, created_by)
      VALUES (${name}, ${mqtt_topic}, ${relay_duration_ms}, ${req.user.id})
      RETURNING id, name, mqtt_topic, relay_duration_ms
    `

    // Назначить администратора группы если указан
    if (admin_id) {
      await db`
        INSERT INTO user_groups (user_id, group_id, role, created_by)
        VALUES (${admin_id}, ${group.id}, 'admin', ${req.user.id})
        ON CONFLICT DO NOTHING
      `
    }

    await db`
      INSERT INTO admin_log (actor_id, action, target_type, target_id)
      VALUES (${req.user.id}, 'create_group', 'group', ${group.id})
    `

    return reply.code(201).send(group)
  })

  // GET /api/sa/logs — журнал администрирования
  app.get('/sa/logs', {
    onRequest: [app.authenticate, requireSuperAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', default: 100, maximum: 500 },
          offset: { type: 'integer', default: 0 }
        }
      }
    }
  }, async (req, reply) => {
    const db = getDb()
    const { limit, offset } = req.query
    return db`
      SELECT al.id, al.action, al.target_type, al.target_id, al.payload, al.ts,
             u.login as actor_login
      FROM admin_log al
      LEFT JOIN users u ON u.id = al.actor_id
      ORDER BY al.ts DESC
      LIMIT ${limit} OFFSET ${offset}
    `
  })
}

module.exports = superadminRoutes

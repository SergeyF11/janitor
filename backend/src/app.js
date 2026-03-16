'use strict'
require('dotenv').config()
const fastify = require('fastify')({ logger: true })
const { migrate } = require('./db/migrate')
const { initDb } = require('./db/connection')
const { startScheduler } = require('./jobs/scheduler')

async function buildApp() {
  await fastify.register(require('@fastify/cors'), { origin: process.env.CORS_ORIGIN || true, credentials: true })
  await fastify.register(require('@fastify/cookie'))
  await fastify.register(require('@fastify/jwt'), { secret: process.env.JWT_SECRET || 'change_me_in_production_please' })
  //await fastify.register(require('@fastify/rate-limit'), { max: 60, timeWindow: '1 minute', keyGenerator: (req) => req.ip })
  await fastify.register(require('@fastify/rate-limit'), {
    max:        500,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const xff = req.headers['x-forwarded-for']
      return xff ? xff.split(',')[0].trim() : req.ip
    },
    skip: (req) => !req.url.includes('/api/'),
  })
  await fastify.register(require('@fastify/static'), { root: require('path').join(__dirname, '..', 'public'), prefix: '/janitor/' })
  await fastify.register(require('@fastify/websocket'))

  await initDb()
  if (process.env.RUN_MIGRATIONS === 'true') await migrate()

  const mqttClient = await require('./mqtt/client').connect()
  fastify.decorate('mqtt', mqttClient)

  const prefix = { prefix: '/janitor/api' }
  await fastify.register(require('./routes/auth'),       prefix)
  await fastify.register(require('./routes/user'),       prefix)
  await fastify.register(require('./routes/admin'),      prefix)
  await fastify.register(require('./routes/superadmin'), prefix)
  await fastify.register(require('./routes/device'),     prefix)
  await fastify.register(require('./ws'), prefix)

  // Явный маршрут для superadmin SPA
  fastify.get('/janitor/superadmin', (req, reply) => reply.redirect('/janitor/superadmin/'))
  fastify.get('/janitor/superadmin/', (req, reply) => reply.sendFile('superadmin.html'))
  fastify.get('/janitor/superadmin/*', (req, reply) => reply.sendFile('superadmin.html'))

  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/janitor/api')) {
      return reply.code(404).send({ error: 'not_found' })
    }
    // Суперадмин — отдельный SPA
    if (req.url.startsWith('/janitor/superadmin')) {
      return reply.sendFile('superadmin.html')
    }
    reply.sendFile('index.html')
  })

  startScheduler()
  
  return fastify
}

module.exports = { buildApp }
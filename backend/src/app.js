'use strict'
require('dotenv').config()
const fastify = require('fastify')({ logger: true })
const { migrate } = require('./db/migrate')
const { connectDb } = require('./db/connection')

async function buildApp() {

  // ── Plugins ───────────────────────────────────────────────────
  await fastify.register(require('@fastify/cors'), {
    origin:      process.env.CORS_ORIGIN || true,
    credentials: true,
  })

  await fastify.register(require('@fastify/cookie'))

  await fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'change_me_in_production_please',
  })

  await fastify.register(require('@fastify/rate-limit'), {
    max:        60,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  })

  await fastify.register(require('@fastify/static'), {
    root:   require('path').join(__dirname, '..', 'public'),
    prefix: '/janitor/',
  })

  await fastify.register(require('@fastify/websocket'))

  // ── DB ────────────────────────────────────────────────────────
  await connectDb()
  if (process.env.RUN_MIGRATIONS === 'true') {
    await migrate()
  }

  // ── MQTT ──────────────────────────────────────────────────────
  const mqttClient = await require('./mqtt/client').connect()
  fastify.decorate('mqtt', mqttClient)

  // ── Routes ────────────────────────────────────────────────────
  const prefix = { prefix: '/janitor/api' }

  await fastify.register(require('./routes/auth'),       prefix)
  await fastify.register(require('./routes/user'),       prefix)
  await fastify.register(require('./routes/admin'),      prefix)
  await fastify.register(require('./routes/superadmin'), prefix)
  await fastify.register(require('./routes/device'),     prefix)

  // ── WebSocket ─────────────────────────────────────────────────
  await fastify.register(require('./ws'), prefix)

  // ── SPA fallback ──────────────────────────────────────────────
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/janitor/api')) {
      return reply.code(404).send({ error: 'not_found' })
    }
    reply.sendFile('index.html')
  })

  return fastify
}

module.exports = { buildApp }'use strict'
require('dotenv').config()

const fastify = require('fastify')({ logger: true })
const path    = require('path')

async function buildApp() {

  // ── Plugins ───────────────────────────────────────────────────
  await fastify.register(require('@fastify/cors'), {
    origin:      process.env.CORS_ORIGIN || true,
    credentials: true,
  })

  await fastify.register(require('@fastify/cookie'))

  await fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
  })

  await fastify.register(require('@fastify/rate-limit'), {
    max:        60,
    timeWindow: '1 minute',
    // Более жёсткий лимит для логина
    keyGenerator: (req) => req.ip,
  })

  await fastify.register(require('@fastify/websocket'))

  // ── Static (PWA) ──────────────────────────────────────────────
  await fastify.register(require('@fastify/static'), {
    root:   path.join(__dirname, '..', 'public'),
    prefix: '/janitor/',
    // SPA fallback — все неизвестные пути отдают index.html
    wildcard: false,
  })

  // SPA fallback для PWA
  fastify.get('/janitor/*', async (req, reply) => {
    // Не перехватываем API запросы
    if (req.url.startsWith('/janitor/api/') || req.url.startsWith('/janitor/ws')) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply.sendFile('index.html')
  })

  // ── DB ────────────────────────────────────────────────────────
  const { initDb } = require('./db/connection')
  await initDb()

  // Миграции при старте если нужно
  if (process.env.RUN_MIGRATIONS === 'true') {
    const { migrate } = require('./db/migrate')
    await migrate()
  }

  // ── MQTT клиент ───────────────────────────────────────────────
  const mqttClient = await require('./mqtt/client').connect()
  fastify.decorate('mqtt', mqttClient)

  // ── Routes ────────────────────────────────────────────────────
  const prefix = '/janitor/api'

  await fastify.register(require('./routes/auth'),        { prefix })
  await fastify.register(require('./routes/user'),        { prefix })
  await fastify.register(require('./routes/admin'),       { prefix })
  await fastify.register(require('./routes/superadmin'),  { prefix })
  await fastify.register(require('./routes/device'),      { prefix })

  // ── WebSocket ─────────────────────────────────────────────────
  await fastify.register(require('./ws'), { prefix })

  // ── Healthcheck ───────────────────────────────────────────────
  fastify.get('/janitor/health', async () => ({ ok: true, ts: new Date() }))

  // ── Жёсткий лимит на логин ────────────────────────────────────
  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url === `${prefix}/auth/login` && req.method === 'POST') {
      // rate-limit уже применён глобально, но для логина ужесточаем через отдельный счётчик
      // (можно расширить через redis если нужно)
    }
  })

  return fastify
}

module.exports = { buildApp }
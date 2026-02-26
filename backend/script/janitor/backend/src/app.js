'use strict'

const Fastify = require('fastify')
const cors = require('@fastify/cors')
const jwt = require('@fastify/jwt')
const cookie = require('@fastify/cookie')
const websocket = require('@fastify/websocket')
const rateLimit = require('@fastify/rate-limit')

const BASE = process.env.BASE_PATH || '/janitor'

async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'warn' : 'info'
    },
    trustProxy: true   // за nginx
  })

  // ── Плагины ────────────────────────────────────────────────────
  await app.register(cors, {
    origin: [`https://${process.env.DOMAIN}`],
    credentials: true
  })

  await app.register(cookie)

  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
    cookie: { cookieName: 'token', signed: false }
  })

  await app.register(websocket)

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    // Триггер кнопки — отдельный лимит (anti-spam)
    keyGenerator: (req) => req.user?.id || req.ip
  })

  // ── Декоратор аутентификации ───────────────────────────────────
  app.decorate('authenticate', async function(req, reply) {
    try {
      await req.jwtVerify()
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' })
    }
  })

  // ── Маршруты ───────────────────────────────────────────────────
  await app.register(require('./routes/health'), { prefix: BASE })
  await app.register(require('./routes/auth'), { prefix: `${BASE}/api` })
  await app.register(require('./routes/user'), { prefix: `${BASE}/api` })
  await app.register(require('./routes/admin'), { prefix: `${BASE}/api` })
  await app.register(require('./routes/superadmin'), { prefix: `${BASE}/api` })
  await app.register(require('./routes/ws'), { prefix: BASE })

  // ── Статика PWA ────────────────────────────────────────────────
  // В продакшне frontend собирается в /app/public
  try {
    const staticPlugin = require('@fastify/static')
    await app.register(staticPlugin, {
      root: require('path').join(__dirname, '..', 'public'),
      prefix: `${BASE}/`,
      decorateReply: false
    })
  } catch (e) {
    app.log.warn('[app] No static files found, skipping')
  }

  return app
}

module.exports = { buildApp }

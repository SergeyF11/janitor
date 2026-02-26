'use strict'

const { loginUser, createSession, deleteSession } = require('../services/auth.service')
const { getDb } = require('../db/connection')

async function authRoutes(app) {

  // POST /api/auth/login
  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['login', 'password'],
        properties: {
          login:       { type: 'string', minLength: 1, maxLength: 100 },
          password:    { type: 'string', minLength: 1 },
          fingerprint: { type: 'string' }
        }
      }
    }
  }, async (req, reply) => {
    const { login, password, fingerprint } = req.body
    const user = await loginUser(login, password)

    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    // Access token — 15 минут
    const accessToken = app.jwt.sign(
      { id: user.id, login: user.login, role: user.role },
      { expiresIn: '15m' }
    )

    // Refresh token — 30 дней, в httpOnly cookie
    const refreshToken = require('crypto').randomBytes(48).toString('hex')
    await createSession(user.id, refreshToken, fingerprint || req.ip)

    reply
      .setCookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: `${process.env.BASE_PATH}/api/auth`,
        maxAge: 30 * 24 * 60 * 60
      })
      .send({
        accessToken,
        user: { id: user.id, login: user.login, role: user.role }
      })
  })

  // POST /api/auth/logout
  app.post('/auth/logout', {
    onRequest: [app.authenticate]
  }, async (req, reply) => {
    const token = req.cookies?.refresh_token
    if (token) {
      // Найти и удалить сессию
      const db = getDb()
      const bcrypt = require('bcryptjs')
      const sessions = await db`
        SELECT id, refresh_token_hash FROM sessions WHERE user_id = ${req.user.id}
      `
      for (const s of sessions) {
        if (await bcrypt.compare(token, s.refresh_token_hash)) {
          await deleteSession(s.id)
          break
        }
      }
    }
    reply.clearCookie('refresh_token').send({ ok: true })
  })

  // GET /api/auth/me
  app.get('/auth/me', {
    onRequest: [app.authenticate]
  }, async (req, reply) => {
    const db = getDb()
    const [user] = await db`
      SELECT id, login, role FROM users WHERE id = ${req.user.id}
    `
    if (!user) return reply.code(404).send({ error: 'User not found' })
    return user
  })
}

module.exports = authRoutes

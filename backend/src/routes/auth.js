'use strict'
const {
  loginUser,
  logoutUser,
  refreshTokens,
  changePassword,
  authenticate,
} = require('../services/auth.service')

// Имя cookie для refresh токена
const REFRESH_COOKIE = 'jrt'

// Настройки cookie — httpOnly, secure, sameSite
function cookieOpts(maxAgeDays = 90) {
  return {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path:     '/janitor/api/auth',
    maxAge:   maxAgeDays * 24 * 60 * 60,
  }
}

async function authRoutes(app) {

  // POST /api/auth/login
  app.post('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['login', 'password'],
        properties: {
          login:    { type: 'string' },
          password: { type: 'string' },
        }
      }
    }
  }, async (req, reply) => {
    const { login, password } = req.body
    const ip        = req.ip
    const userAgent = req.headers['user-agent'] || ''

    try {
      const result = await loginUser(login, password, ip, userAgent, app)

      // Refresh token — в httpOnly cookie
      reply.setCookie(REFRESH_COOKIE, result.refreshToken, cookieOpts(90))

      return {
        accessToken: result.accessToken,
        user:        result.user,
      }
    } catch (err) {
      if (err.message === 'session_exists') {
        return reply.code(403).send({ error: 'session_exists' })
      }
      if (err.message === 'user_inactive') {
        return reply.code(403).send({ error: 'user_inactive' })
      }
      return reply.code(401).send({ error: 'invalid_credentials' })
    }
  })

  // POST /api/auth/refresh
  // Вызывается каждые 15 минут пока есть интернет
  // При успехе ротирует refresh token и возвращает новый access token
  app.post('/auth/refresh', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE]
    if (!token) {
      return reply.code(401).send({ error: 'no_refresh_token' })
    }

    const ip        = req.ip
    const userAgent = req.headers['user-agent'] || ''

    try {
      const result = await refreshTokens(token, ip, userAgent, app)

      // Обновляем cookie с новым refresh токеном
      reply.setCookie(REFRESH_COOKIE, result.newRefreshToken, cookieOpts(90))

      return {
        accessToken: result.accessToken,
        user:        result.user,
      }
    } catch (err) {
      // Сбрасываем невалидный cookie
      reply.clearCookie(REFRESH_COOKIE, { path: '/janitor/api/auth' })
      return reply.code(401).send({ error: 'invalid_refresh_token' })
    }
  })

  // POST /api/auth/logout
  app.post('/auth/logout', {
    onRequest: [authenticate]
  }, async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE]
    await logoutUser(req.user.id, token)
    reply.clearCookie(REFRESH_COOKIE, { path: '/janitor/api/auth' })
    return { ok: true }
  })

  // GET /api/auth/me — получить текущего пользователя
  app.get('/auth/me', {
    onRequest: [authenticate]
  }, async (req, reply) => {
    const { getDb } = require('../db/connection')
    const db = getDb()

    const [user] = await db`
      SELECT id, login, display_name, phone, email,
             role, single_session, must_change_password, created_at
      FROM users WHERE id = ${req.user.id}
    `
    if (!user) return reply.code(404).send({ error: 'not_found' })
    return user
  })

  // POST /api/auth/change-password
  app.post('/auth/change-password', {
    onRequest: [authenticate],
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
    // keepSession=true: после смены пароля пользователь остаётся залогинен
    // Новый refresh token выдаётся сразу
    await changePassword(req.user.id, req.body.password, true)

    // Выдаём новый refresh token (старые сброшены в changePassword)
    const ip        = req.ip
    const userAgent = req.headers['user-agent'] || ''

    const { issueRefreshToken, buildJwtPayload } = require('../services/auth.service')
    const { getDb } = require('../db/connection')
    const db = getDb()

    const [user] = await db`
      SELECT id, login, role, single_session, must_change_password, token_version
      FROM users WHERE id = ${req.user.id}
    `

    const newRefreshToken = await issueRefreshToken(user.id, ip, userAgent)
    const accessToken     = app.jwt.sign(buildJwtPayload(user), { expiresIn: '15m' })

    reply.setCookie(REFRESH_COOKIE, newRefreshToken, cookieOpts(90))

    return {
      ok: true,
      accessToken,
      user: {
        id:                   user.id,
        login:                user.login,
        role:                 user.role,
        single_session:       user.single_session,
        must_change_password: user.must_change_password,
      }
    }
  })
}

module.exports = authRoutes
module.exports.REFRESH_COOKIE = REFRESH_COOKIE
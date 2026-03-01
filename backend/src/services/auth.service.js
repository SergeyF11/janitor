'use strict'
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const { getDb } = require('../db/connection')

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex')
}

function buildJwtPayload(user) {
  return {
    sub:            user.id,
    login:          user.login,
    role:           user.role,
    tv:             user.token_version,
    single_session: user.single_session,
  }
}

// ── Создать пользователя ──────────────────────────────────────
async function createUser(login, password, role, createdBy, options = {}) {
  const db = getDb()
  const {
    must_change_password = true,
    single_session = true,
    display_name = null,
    phone = null,
    email = null,
  } = options

  const hash = await bcrypt.hash(password, 12)
  const [user] = await db`
    INSERT INTO users (
      login, password_hash, role, created_by,
      must_change_password, single_session,
      display_name, phone, email
    )
    VALUES (
      ${login}, ${hash}, ${role}, ${createdBy},
      ${must_change_password}, ${single_session},
      ${display_name}, ${phone}, ${email}
    )
    RETURNING id, login, role, single_session, must_change_password, token_version
  `
  return user
}

// ── Выдать refresh token ──────────────────────────────────────
async function issueRefreshToken(userId, ip, userAgent) {
  const db = getDb()
  const token = generateRefreshToken()
  const hash = hashToken(token)

  await db`
    INSERT INTO refresh_tokens (user_id, token_hash, ip, user_agent)
    VALUES (${userId}, ${hash}, ${ip || null}, ${userAgent || null})
  `
  return token
}

// ── Логин ─────────────────────────────────────────────────────
async function loginUser(login, password, ip, userAgent, fastify) {
  const db = getDb()

  const [user] = await db`
    SELECT id, login, password_hash, role, single_session,
           must_change_password, is_active, token_version
    FROM users WHERE login = ${login}
  `
  if (!user) throw new Error('invalid_credentials')
  if (!user.is_active) throw new Error('user_inactive')

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) throw new Error('invalid_credentials')

  // single_session: если уже есть активная сессия — отказать
  if (user.single_session) {
    const [existing] = await db`
      SELECT id FROM refresh_tokens
      WHERE user_id = ${user.id} AND expires_at > NOW()
      LIMIT 1
    `
    if (existing) throw new Error('session_exists')
  }

  const refreshToken = await issueRefreshToken(user.id, ip, userAgent)
  const accessToken  = fastify.jwt.sign(buildJwtPayload(user), { expiresIn: '15m' })

  await db`
    INSERT INTO event_log (actor_id, actor_login, action, ip)
    VALUES (${user.id}, ${user.login}, 'login', ${ip || null})
  `

  return {
    accessToken,
    refreshToken,
    user: {
      id:                   user.id,
      login:                user.login,
      role:                 user.role,
      single_session:       user.single_session,
      must_change_password: user.must_change_password,
    }
  }
}

// ── Обновить токены (refresh) ─────────────────────────────────
// Ротация: старый refresh удаляется, выдаётся новый + новый access
async function refreshTokens(token, ip, userAgent, fastify) {
  const db = getDb()
  const hash = hashToken(token)

  const [rt] = await db`
    SELECT rt.id, rt.user_id,
           u.login, u.role, u.single_session,
           u.must_change_password, u.is_active, u.token_version
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.token_hash = ${hash} AND rt.expires_at > NOW()
  `
  if (!rt) throw new Error('invalid_refresh_token')
  if (!rt.is_active) throw new Error('user_inactive')

  // Ротируем: удаляем старый, создаём новый со скользящим окном
  await db`DELETE FROM refresh_tokens WHERE token_hash = ${hash}`
  const newRefreshToken = await issueRefreshToken(rt.user_id, ip, userAgent)

  const user = {
    id:            rt.user_id,
    login:         rt.login,
    role:          rt.role,
    single_session: rt.single_session,
    must_change_password: rt.must_change_password,
    token_version: rt.token_version,
  }

  const accessToken = fastify.jwt.sign(buildJwtPayload(user), { expiresIn: '15m' })

  return {
    accessToken,
    newRefreshToken,
    user: {
      id:                   user.id,
      login:                user.login,
      role:                 user.role,
      single_session:       user.single_session,
      must_change_password: user.must_change_password,
    }
  }
}

// ── Выход ─────────────────────────────────────────────────────
async function logoutUser(userId, refreshToken) {
  const db = getDb()
  if (refreshToken) {
    await db`DELETE FROM refresh_tokens WHERE token_hash = ${hashToken(refreshToken)}`
  }
  await db`
    INSERT INTO event_log (actor_id, action)
    VALUES (${userId}, 'logout')
  `
}

// ── Сброс всех сессий пользователя ───────────────────────────
async function resetUserSessions(targetId, actorId) {
  const db = getDb()

  await db`DELETE FROM refresh_tokens WHERE user_id = ${targetId}`
  // Инкремент token_version инвалидирует все выданные access токены
  await db`
    UPDATE users SET token_version = token_version + 1, updated_at = NOW()
    WHERE id = ${targetId}
  `

  if (actorId) {
    await db`
      INSERT INTO event_log (actor_id, action, target_type, target_id)
      VALUES (${actorId}, 'reset_sessions', 'user', ${targetId})
    `
  }
}

// ── Смена пароля ──────────────────────────────────────────────
async function changePassword(userId, newPassword, keepSession = false) {
  const db = getDb()
  const hash = await bcrypt.hash(newPassword, 12)

  await db`
    UPDATE users
    SET password_hash        = ${hash},
        must_change_password = false,
        token_version        = token_version + 1,
        updated_at           = NOW()
    WHERE id = ${userId}
  `

  if (!keepSession) {
    await db`DELETE FROM refresh_tokens WHERE user_id = ${userId}`
  }
}

// ── Fastify preHandler: authenticate ─────────────────────────
async function authenticate(req, reply) {
  try {
    await req.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'unauthorized' })
  }

  const db = getDb()
  const [user] = await db`
    SELECT token_version, is_active FROM users WHERE id = ${req.user.sub}
  `
  if (!user || !user.is_active) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  if (user.token_version !== req.user.tv) {
    return reply.code(401).send({ error: 'token_invalidated' })
  }

  req.user.id = req.user.sub
}

// ── Fastify preHandler: requireRole ──────────────────────────
function requireRole(...roles) {
  return async function (req, reply) {
    if (!roles.includes(req.user.role)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
  }
}

module.exports = {
  createUser,
  loginUser,
  logoutUser,
  issueRefreshToken,
  refreshTokens,
  resetUserSessions,
  changePassword,
  buildJwtPayload,
  hashToken,
  authenticate,
  requireRole,
}
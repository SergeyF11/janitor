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
async function loginUser(loginStr, password, ip, userAgent, fastify, fingerprint = null) {
  const db = getDb()

  let user

  const atIdx = loginStr.lastIndexOf('@')
  if (atIdx > 0) {
    const login      = loginStr.substring(0, atIdx)
    const groupTopic = loginStr.substring(atIdx + 1)

    // Попытка 1: user@mqtt_topic
    const [userRow] = await db`
      SELECT u.id, u.login, u.password_hash, u.role, u.single_session,
             u.must_change_password, u.is_active, u.token_version,
             u.device_fingerprint, u.mqtt_password
      FROM users u
      JOIN user_groups ug ON ug.user_id = u.id
      JOIN groups g       ON g.id = ug.group_id
      WHERE u.login      = ${login}
        AND g.mqtt_topic = ${groupTopic}
        AND u.role       = 'user'
        AND g.status     = 'active'
        AND (g.expires_at IS NULL OR g.expires_at > NOW() OR g.grace_until > NOW())
      LIMIT 1
    `
    console.log('[debug] userRow:', userRow ? userRow.login : 'null', 'login:', login, 'groupTopic:', groupTopic)
    if (userRow) {
      user = userRow
    } else {
      // Попытка 2: admin@something — полный логин как есть
      const [adminRow] = await db`
        SELECT id, login, password_hash, role, single_session,
               must_change_password, is_active, token_version,
               device_fingerprint, mqtt_password
        FROM users
        WHERE login = ${loginStr}
          AND role IN ('admin', 'superadmin')
      `
      console.log('[debug] adminRow:', adminRow ? adminRow.login : 'null')
      user = adminRow
    }
  } else {
    // Без @ — только admin/superadmin
    const [row] = await db`
      SELECT id, login, password_hash, role, single_session,
             must_change_password, is_active, token_version,
             device_fingerprint, mqtt_password
      FROM users
      WHERE login = ${loginStr}
        AND role IN ('admin', 'superadmin')
    `
    user = row
  }

  if (!user) throw new Error('invalid_credentials')
  if (!user.is_active) throw new Error('user_inactive')

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) throw new Error('invalid_credentials')

  // single_session: одна активная сессия — удаляем все старые перед созданием новой
  // Исключение: если токен создан в последние 5 секунд (защита от двойного рендера React)
  if (user.single_session) {
    const [existing] = await db`
      SELECT id FROM refresh_tokens
      WHERE user_id = ${user.id}
        AND expires_at > NOW()
        AND created_at < NOW() - INTERVAL '5 seconds'
      LIMIT 1
    `
    if (existing) throw new Error('session_exists')
    // Чистим дубликаты от React StrictMode
    await db`
      DELETE FROM refresh_tokens
      WHERE user_id = ${user.id}
        AND expires_at > NOW()
    `
  }

  // ── Device fingerprint ──────────────────────────────────────
  // Только для пользователей и single_session админов, не для суперадмина
  const needsFingerprint = user.role === 'user' || (user.role === 'admin' && user.single_session)
  if (needsFingerprint && fingerprint) {
    if (!user.device_fingerprint) {
      // Первый вход — привязать устройство
      await db`UPDATE users SET device_fingerprint = ${fingerprint}, updated_at = NOW() WHERE id = ${user.id}`
      user.device_fingerprint = fingerprint
    } else if (user.device_fingerprint !== fingerprint) {
      throw new Error('device_mismatch')
    }
  }

  // ── MQTT credentials ─────────────────────────────────────────
  // Только для пользователей и одиночных-сессионных админов
  let mqttCreds = null
  if (user.role === 'user' || (user.role === 'admin' && user.single_session)) {
    let mqttPass = user.mqtt_password
    const mqttUser = `u_${user.id.replace(/-/g, '').substring(0, 16)}`

    if (!mqttPass) {
      // Первый логин — сгенерировать и сохранить
      mqttPass = generateMqttPassword()
      await db`UPDATE users SET mqtt_password = ${mqttPass}, updated_at = NOW() WHERE id = ${user.id}`
    }

    // Получить устройства групп пользователя
    const devices = await db`
      SELECT DISTINCT dg.device_id
      FROM user_groups ug
      JOIN device_groups dg ON dg.group_id = ug.group_id
      WHERE ug.user_id = ${user.id}
    `
    const deviceIds = devices.map(d => d.device_id)

    // Создать/обновить MQTT клиента в dynsec
    try {
      await dynsec.createUserClient(mqttUser, mqttPass, deviceIds)
    } catch (e) {
      console.error('[dynsec] createUserClient error:', e.message)
    }

    const mqttHost = process.env.MQTT_WS_HOST || 'ws://localhost:9001'
    mqttCreds = {
      host:     mqttHost,
      username: mqttUser,
      password: mqttPass,
      devices:  deviceIds,
    }
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
    mqtt: mqttCreds,
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
  // device_fingerprint сбрасывается — следующий вход разрешён только с нового устройства
  // mqtt_password НЕ сбрасывается — PWA сохраняет MQTT соединение
  await db`
    UPDATE users SET token_version = token_version + 1,
                     device_fingerprint = NULL,
                     updated_at = NOW()
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
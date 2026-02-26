'use strict'

const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const { getDb } = require('../db/connection')

// ── Создать суперадмина при первом запуске ─────────────────────
async function ensureSuperAdmin() {
  const db = getDb()
  const login = process.env.SUPERADMIN_LOGIN
  const password = process.env.SUPERADMIN_PASSWORD

  if (!login || !password) {
    throw new Error('[auth] SUPERADMIN_LOGIN and SUPERADMIN_PASSWORD must be set in .env')
  }

  const [existing] = await db`SELECT id FROM users WHERE login = ${login}`
  if (existing) {
    console.log(`[auth] SuperAdmin "${login}" already exists`)
    return
  }

  const hash = await bcrypt.hash(password, 12)
  await db`
    INSERT INTO users (login, password_hash, role)
    VALUES (${login}, ${hash}, 'superadmin')
  `
  console.log(`[auth] SuperAdmin "${login}" created`)
}

// ── Вход ───────────────────────────────────────────────────────
async function loginUser(login, password) {
  const db = getDb()
  const [user] = await db`
    SELECT id, login, password_hash, role
    FROM users WHERE login = ${login}
  `
  if (!user) return null

  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return null

  return { id: user.id, login: user.login, role: user.role }
}

// ── Создать пользователя ───────────────────────────────────────
async function createUser(login, password, role, createdBy) {
  const db = getDb()
  const hash = await bcrypt.hash(password, 12)
  const [user] = await db`
    INSERT INTO users (login, password_hash, role, created_by)
    VALUES (${login}, ${hash}, ${role}, ${createdBy})
    RETURNING id, login, role, created_at
  `
  return user
}

// ── Сессии ─────────────────────────────────────────────────────
async function createSession(userId, refreshToken, fingerprint) {
  const db = getDb()
  const hash = await bcrypt.hash(refreshToken, 8)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 дней
  const [session] = await db`
    INSERT INTO sessions (user_id, refresh_token_hash, device_fingerprint, expires_at)
    VALUES (${userId}, ${hash}, ${fingerprint}, ${expiresAt})
    RETURNING id
  `
  return session.id
}

async function deleteSession(sessionId) {
  const db = getDb()
  await db`DELETE FROM sessions WHERE id = ${sessionId}`
}

module.exports = { ensureSuperAdmin, loginUser, createUser, createSession, deleteSession }

'use strict'

const { getDb } = require('./connection')

async function initDb() {
  // Проверка подключения с retry
  const db = getDb()
  let attempts = 0
  while (attempts < 10) {
    try {
      await db`SELECT 1`
      console.log('[db] Connected to PostgreSQL')
      return
    } catch (e) {
      attempts++
      console.log(`[db] Waiting for PostgreSQL... (${attempts}/10)`)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  throw new Error('[db] Could not connect to PostgreSQL')
}

async function runMigrations() {
  const db = getDb()
  console.log('[db] Running migrations...')

  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `

  // Получаем текущую версию
  const [row] = await db`SELECT COALESCE(MAX(version), 0) as v FROM schema_migrations`
  let version = parseInt(row.v)
  console.log(`[db] Current schema version: ${version}`)

  // ── Migration 1: базовая схема ────────────────────────────────
  if (version < 1) {
    await db.begin(async db => {

      // Пользователи
      await db`
        CREATE TABLE users (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          login         VARCHAR(100) UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role          VARCHAR(20) NOT NULL DEFAULT 'user',
          created_by    UUID,
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        )
      `

      // Группы (каналы управления реле)
      await db`
        CREATE TABLE groups (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name              VARCHAR(100) NOT NULL,
          mqtt_topic        VARCHAR(200) UNIQUE NOT NULL,
          relay_duration_ms INTEGER NOT NULL DEFAULT 500,
          relay_state       BOOLEAN NOT NULL DEFAULT FALSE,
          created_by        UUID REFERENCES users(id),
          created_at        TIMESTAMPTZ DEFAULT NOW(),
          updated_at        TIMESTAMPTZ DEFAULT NOW()
        )
      `

      // Связь пользователей с группами
      await db`
        CREATE TABLE user_groups (
          user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
          group_id   UUID REFERENCES groups(id) ON DELETE CASCADE,
          role       VARCHAR(20) NOT NULL DEFAULT 'user',
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (user_id, group_id)
        )
      `

      // Устройства (ESP)
      await db`
        CREATE TABLE devices (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          device_id    VARCHAR(50) UNIQUE NOT NULL,
          fw_version   VARCHAR(50),
          mqtt_user    VARCHAR(100) UNIQUE,
          mqtt_pass_hash TEXT,
          last_seen    TIMESTAMPTZ,
          created_at   TIMESTAMPTZ DEFAULT NOW()
        )
      `

      // Связь устройств с группами (1 реле = 1 группа)
      await db`
        CREATE TABLE device_groups (
          device_id  UUID REFERENCES devices(id) ON DELETE CASCADE,
          group_id   UUID REFERENCES groups(id) ON DELETE CASCADE,
          relay_num  INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (device_id, group_id)
        )
      `

      // Сессии пользователей
      await db`
        CREATE TABLE sessions (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id            UUID REFERENCES users(id) ON DELETE CASCADE,
          refresh_token_hash TEXT NOT NULL,
          device_fingerprint TEXT,
          created_at         TIMESTAMPTZ DEFAULT NOW(),
          expires_at         TIMESTAMPTZ NOT NULL,
          last_used_at       TIMESTAMPTZ DEFAULT NOW()
        )
      `

      // Журнал событий группы
      await db`
        CREATE TABLE event_log (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          group_id    UUID REFERENCES groups(id),
          user_id     UUID REFERENCES users(id),
          source      VARCHAR(30) NOT NULL DEFAULT 'pwa',
          action      VARCHAR(50) NOT NULL,
          payload     JSONB,
          ts          TIMESTAMPTZ DEFAULT NOW()
        )
      `
      await db`CREATE INDEX idx_event_log_group_ts ON event_log(group_id, ts DESC)`

      // Журнал администрирования (виден суперадмину)
      await db`
        CREATE TABLE admin_log (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          actor_id    UUID REFERENCES users(id),
          action      VARCHAR(100) NOT NULL,
          target_type VARCHAR(50),
          target_id   UUID,
          payload     JSONB,
          ts          TIMESTAMPTZ DEFAULT NOW()
        )
      `
      await db`CREATE INDEX idx_admin_log_ts ON admin_log(ts DESC)`

      await db`INSERT INTO schema_migrations(version) VALUES(1)`
    })
    console.log('[db] Migration 1 applied: base schema')
    version = 1
  }

  console.log('[db] Migrations complete')
}

module.exports = { initDb, runMigrations }

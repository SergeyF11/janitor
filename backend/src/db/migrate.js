'use strict'
const bcrypt = require('bcryptjs')
const { getDb } = require('./connection')

async function migrate() {
  const db = getDb()
  console.log('[migrate] Starting...')

  await db.unsafe(`

    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    DROP TABLE IF EXISTS event_log       CASCADE;
    DROP TABLE IF EXISTS device_tokens   CASCADE;
    DROP TABLE IF EXISTS user_groups     CASCADE;
    DROP TABLE IF EXISTS relays          CASCADE;
    DROP TABLE IF EXISTS devices         CASCADE;
    DROP TABLE IF EXISTS groups          CASCADE;
    DROP TABLE IF EXISTS refresh_tokens  CASCADE;
    DROP TABLE IF EXISTS users           CASCADE;

    -- ── users ──────────────────────────────────────────────────
    CREATE TABLE users (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      login                TEXT NOT NULL UNIQUE,
      password_hash        TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'user',
      must_change_password BOOLEAN NOT NULL DEFAULT true,
      single_session       BOOLEAN NOT NULL DEFAULT true,
      is_active            BOOLEAN NOT NULL DEFAULT true,
      display_name         TEXT,
      email                TEXT,
      phone                TEXT,
      created_by           UUID,
      token_version        INTEGER NOT NULL DEFAULT 1,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── refresh_tokens ─────────────────────────────────────────
    CREATE TABLE refresh_tokens (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      ip          TEXT,
      user_agent  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    );

    -- ── groups ─────────────────────────────────────────────────
    -- Группа = ESP устройство (логическая единица доступа)
    CREATE TABLE groups (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT NOT NULL,
      mqtt_topic  TEXT NOT NULL UNIQUE,
      status      TEXT NOT NULL DEFAULT 'active',
      expires_at  TIMESTAMPTZ,
      grace_until TIMESTAMPTZ,
      user_quota  INTEGER NOT NULL DEFAULT 0,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── devices ────────────────────────────────────────────────
    -- Физический ESP. Один ESP = одна группа (UNIQUE group_id)
    CREATE TABLE devices (
      device_id     TEXT PRIMARY KEY,
      group_id      UUID UNIQUE REFERENCES groups(id) ON DELETE SET NULL,
      mqtt_user     TEXT,
      mqtt_password TEXT,
      is_online     BOOLEAN NOT NULL DEFAULT false,
      fw_version    TEXT,
      last_seen     TIMESTAMPTZ,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── relays ─────────────────────────────────────────────────
    -- Реле на ESP
    CREATE TABLE relays (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id     TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      relay_index   INTEGER NOT NULL,
      name          TEXT NOT NULL,
      duration_ms   INTEGER NOT NULL DEFAULT 500,
      last_state    TEXT,
      last_state_at TIMESTAMPTZ,
      UNIQUE (device_id, relay_index)
    );

    -- ── user_groups ────────────────────────────────────────────
    CREATE TABLE user_groups (
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'user',
      description TEXT,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, group_id)
    );

    -- ── device_tokens ──────────────────────────────────────────
    CREATE TABLE device_tokens (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id    UUID NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
      code        TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── event_log ──────────────────────────────────────────────
    CREATE TABLE event_log (
      id          BIGSERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      action      TEXT NOT NULL,
      actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
      actor_login TEXT,
      target_type TEXT,
      target_id   TEXT,
      group_id    UUID REFERENCES groups(id) ON DELETE SET NULL,
      relay_id    UUID REFERENCES relays(id) ON DELETE SET NULL,
      payload     JSONB,
      ip          TEXT
    );

    -- ── Индексы ────────────────────────────────────────────────
    CREATE INDEX ON refresh_tokens (user_id);
    CREATE INDEX ON refresh_tokens (expires_at);
    CREATE INDEX ON relays (device_id);
    CREATE INDEX ON user_groups (user_id);
    CREATE INDEX ON user_groups (group_id);
    CREATE INDEX ON event_log (group_id, ts DESC);
    CREATE INDEX ON event_log (relay_id, ts DESC);
    CREATE INDEX ON event_log (actor_id, ts DESC);

    -- ── Триггер: удалять orphan users (role=user без групп) ────
    CREATE OR REPLACE FUNCTION auto_delete_orphan_user() RETURNS TRIGGER AS $$
    BEGIN
      DELETE FROM users
      WHERE id = OLD.user_id
        AND role = 'user'
        AND NOT EXISTS (SELECT 1 FROM user_groups WHERE user_id = OLD.user_id);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_auto_delete_orphan_user
    AFTER DELETE ON user_groups
    FOR EACH ROW EXECUTE FUNCTION auto_delete_orphan_user();

  `)

  // ── Суперадмин ───────────────────────────────────────────────
  const saLogin    = process.env.SUPERADMIN_LOGIN    || 'superadmin'
  const saPassword = process.env.SUPERADMIN_PASSWORD || 'change_me'
  const saHash     = await bcrypt.hash(saPassword, 12)

  await db`
    INSERT INTO users (login, password_hash, role, must_change_password, single_session)
    VALUES (${saLogin}, ${saHash}, 'superadmin', false, false)
    ON CONFLICT (login) DO UPDATE
      SET password_hash = ${saHash}, role = 'superadmin'
  `
  console.log(`[migrate] Superadmin: ${saLogin}`)
  console.log('[migrate] Done')
}

module.exports = { migrate }
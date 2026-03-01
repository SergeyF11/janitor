'use strict'
const { getDb } = require('./connection')
const bcrypt = require('bcryptjs')

async function migrate() {
  const db = getDb()
  console.log('[db] Starting migration from scratch...')

  await db.unsafe(`
    DROP TABLE IF EXISTS event_log       CASCADE;
    DROP TABLE IF EXISTS device_tokens   CASCADE;
    DROP TABLE IF EXISTS device_groups   CASCADE;
    DROP TABLE IF EXISTS devices         CASCADE;
    DROP TABLE IF EXISTS user_groups     CASCADE;
    DROP TABLE IF EXISTS groups          CASCADE;
    DROP TABLE IF EXISTS refresh_tokens  CASCADE;
    DROP TABLE IF EXISTS users           CASCADE;
    DROP TYPE  IF EXISTS user_role;
    DROP TYPE  IF EXISTS group_status;
  `)
  console.log('[db] Dropped all tables')

  await db.unsafe(`
    CREATE TYPE user_role    AS ENUM ('superadmin', 'admin', 'user');
    CREATE TYPE group_status AS ENUM ('active', 'blocked');
  `)

  await db.unsafe(`
    CREATE TABLE users (
      id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      login                VARCHAR(100) NOT NULL UNIQUE,
      password_hash        TEXT         NOT NULL,
      display_name         VARCHAR(200),
      phone                VARCHAR(50),
      email                VARCHAR(200),
      role                 user_role    NOT NULL DEFAULT 'user',
      single_session       BOOLEAN      NOT NULL DEFAULT true,
      must_change_password BOOLEAN      NOT NULL DEFAULT true,
      is_active            BOOLEAN      NOT NULL DEFAULT true,
      token_version        INTEGER      NOT NULL DEFAULT 0,
      created_by           UUID         REFERENCES users(id) ON DELETE SET NULL,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `)

  // Скользящее окно 90 дней: каждое использование продлевает срок
  await db.unsafe(`
    CREATE TABLE refresh_tokens (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT        NOT NULL UNIQUE,
      expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      ip           VARCHAR(50),
      user_agent   TEXT
    );
    CREATE INDEX idx_rt_user_id    ON refresh_tokens(user_id);
    CREATE INDEX idx_rt_token_hash ON refresh_tokens(token_hash);
  `)

  await db.unsafe(`
    CREATE TABLE groups (
      id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name              VARCHAR(100) NOT NULL,
      mqtt_topic        VARCHAR(100) NOT NULL UNIQUE,
      relay_duration_ms INTEGER      NOT NULL DEFAULT 500,
      status            group_status NOT NULL DEFAULT 'active',
      expires_at        TIMESTAMPTZ,
      grace_until       TIMESTAMPTZ,
      user_quota        INTEGER      NOT NULL DEFAULT 0,
      created_by        UUID         REFERENCES users(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `)

  await db.unsafe(`
    CREATE TABLE user_groups (
      user_id     UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      group_id    UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      role        user_role   NOT NULL DEFAULT 'user',
      description TEXT,
      created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, group_id),
      CONSTRAINT chk_ug_role CHECK (role IN ('admin', 'user'))
    );
    CREATE INDEX idx_ug_group_id ON user_groups(group_id);
    CREATE INDEX idx_ug_user_id  ON user_groups(user_id);
  `)

  // Автоудаление user без групп
  await db.unsafe(`
    CREATE OR REPLACE FUNCTION auto_delete_orphan_user()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM user_groups WHERE user_id = OLD.user_id) THEN
        DELETE FROM users WHERE id = OLD.user_id AND role = 'user';
      END IF;
      RETURN OLD;
    END;
    $$;
    CREATE TRIGGER trg_auto_delete_orphan_user
    AFTER DELETE ON user_groups
    FOR EACH ROW EXECUTE FUNCTION auto_delete_orphan_user();
  `)

  await db.unsafe(`
    CREATE TABLE devices (
      device_id      VARCHAR(50)  PRIMARY KEY,
      mqtt_user      VARCHAR(100) NOT NULL UNIQUE,
      mqtt_pass_hash TEXT         NOT NULL,
      fw_version     VARCHAR(50),
      last_seen      TIMESTAMPTZ,
      registered_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `)

  await db.unsafe(`
    CREATE TABLE device_groups (
      device_id   VARCHAR(50) NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      group_id    UUID        NOT NULL REFERENCES groups(id)          ON DELETE CASCADE,
      relay_index INTEGER     NOT NULL DEFAULT 0,
      PRIMARY KEY (device_id, group_id, relay_index)
    );
    CREATE INDEX idx_dg_group_id  ON device_groups(group_id);
    CREATE INDEX idx_dg_device_id ON device_groups(device_id);
  `)

  await db.unsafe(`
    CREATE TABLE device_tokens (
      group_id   UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      code       VARCHAR(6)  NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_by UUID        REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (group_id)
    );
  `)

  await db.unsafe(`
    CREATE TABLE event_log (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
      actor_login VARCHAR(100),
      action      VARCHAR(100) NOT NULL,
      target_type VARCHAR(50),
      target_id   VARCHAR(100),
      group_id    UUID         REFERENCES groups(id) ON DELETE SET NULL,
      payload     JSONB,
      ip          VARCHAR(50),
      ts          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_el_ts       ON event_log(ts DESC);
    CREATE INDEX idx_el_group_id ON event_log(group_id);
    CREATE INDEX idx_el_actor_id ON event_log(actor_id);
  `)

  const hash = await bcrypt.hash(process.env.SUPERADMIN_PASSWORD || 'SuperAdmin123!', 12)
  await db`
    INSERT INTO users (login, password_hash, role, must_change_password, single_session, token_version)
    VALUES (
      ${process.env.SUPERADMIN_LOGIN || 'superadmin'},
      ${hash}, 'superadmin', false, false, 0
    )
    ON CONFLICT (login) DO NOTHING
  `

  console.log('[db] Migration complete ✓')
  console.log(`[db] SuperAdmin: ${process.env.SUPERADMIN_LOGIN || 'superadmin'}`)
}

module.exports = { migrate }
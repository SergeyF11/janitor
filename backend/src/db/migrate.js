'use strict'
const { getDb } = require('./connection')

async function migrate() {
  const db = getDb()

  // ── Типы ──────────────────────────────────────────────────────
  await db.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('superadmin', 'admin', 'user');
      END IF;
    END $$;
  `)
  await db.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'group_status') THEN
        CREATE TYPE group_status AS ENUM ('active', 'blocked', 'deleted');
      ELSE
        BEGIN ALTER TYPE group_status ADD VALUE IF NOT EXISTS 'deleted'; EXCEPTION WHEN duplicate_object THEN END;
      END IF;
    END $$;
  `)

  // ── users ─────────────────────────────────────────────────────
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS users (
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

  // ── groups ────────────────────────────────────────────────────
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS groups (
      id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name              VARCHAR(100) NOT NULL,
      mqtt_topic        VARCHAR(100) NOT NULL UNIQUE,
      relay_duration_ms INTEGER      NOT NULL DEFAULT 500,
      status            group_status NOT NULL DEFAULT 'active',
      expires_at        TIMESTAMPTZ,
      grace_until       TIMESTAMPTZ,
      blocked_at        TIMESTAMPTZ,
      user_quota        INTEGER      NOT NULL DEFAULT 0,
      created_by        UUID         REFERENCES users(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `)

  await db.unsafe(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS blocked_at  TIMESTAMPTZ;`)
  await db.unsafe(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ;`)
  await db.unsafe(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ;`)

  // Индексы для планировщика (частые запросы по status + expires_at + blocked_at)
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_groups_status      ON groups(status);`)
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_groups_expires_at  ON groups(expires_at) WHERE expires_at IS NOT NULL;`)
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_groups_blocked_at  ON groups(blocked_at) WHERE blocked_at IS NOT NULL;`)
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_groups_grace_until ON groups(grace_until) WHERE grace_until IS NOT NULL;`)

  // Индекс для фильтрации событий планировщика в журнале
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_el_action ON event_log(action);`)

  // ── user_groups ───────────────────────────────────────────────
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS user_groups (
      user_id     UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      group_id    UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      role        user_role   NOT NULL DEFAULT 'user',
      description TEXT,
      created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, group_id),
      CONSTRAINT chk_ug_role CHECK (role IN ('admin', 'user'))
    );
    CREATE INDEX IF NOT EXISTS idx_ug_user_id  ON user_groups(user_id);
    CREATE INDEX IF NOT EXISTS idx_ug_group_id ON user_groups(group_id);
  `)

  // ── devices ───────────────────────────────────────────────────
  // group_id: один device на группу (UNIQUE)
  // is_online: актуальный онлайн-статус, обновляется MQTT-клиентом
  // mqtt_password: plain text для передачи ESP (hash хранится в mqtt_pass_hash)
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id      VARCHAR(50)  PRIMARY KEY,
      group_id       UUID         REFERENCES groups(id) ON DELETE SET NULL,
      mqtt_user      VARCHAR(100) NOT NULL UNIQUE,
      mqtt_password  TEXT         NOT NULL DEFAULT '',
      fw_version     VARCHAR(50),
      is_online      BOOLEAN      NOT NULL DEFAULT false,
      last_seen      TIMESTAMPTZ,
      registered_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_devices_group_id ON devices(group_id);
  `)

  await db.unsafe(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS group_id     UUID    REFERENCES groups(id) ON DELETE SET NULL;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_online    BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_password TEXT   NOT NULL DEFAULT '';
  `)

  await db.unsafe(`
    UPDATE devices d
    SET group_id = dg.group_id
    FROM (
      SELECT DISTINCT ON (device_id) device_id, group_id
      FROM device_groups ORDER BY device_id
    ) dg
    WHERE d.device_id = dg.device_id AND d.group_id IS NULL;
  `)

  // ── relays ────────────────────────────────────────────────────
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS relays (
      id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id    TEXT    NOT NULL,
      relay_index  INTEGER NOT NULL,
      name         TEXT    NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 500,
      last_state   TEXT,
      last_state_at TIMESTAMPTZ,
      UNIQUE (device_id, relay_index)
    );
    CREATE INDEX IF NOT EXISTS relays_device_id_idx ON relays(device_id);
  `)

  // ── device_tokens ─────────────────────────────────────────────
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      group_id    UUID        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      code        VARCHAR(6)  NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (group_id)
    );
  `)

  // ── refresh_tokens ────────────────────────────────────────────
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT        NOT NULL UNIQUE,
      expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      ip           VARCHAR(50),
      user_agent   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rt_token_hash ON refresh_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_rt_user_id    ON refresh_tokens(user_id);
  `)

  // ── event_log ─────────────────────────────────────────────────
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS event_log (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
      actor_login VARCHAR(100),
      action      VARCHAR(100) NOT NULL,
      target_type VARCHAR(50),
      target_id   VARCHAR(100),
      group_id    UUID        REFERENCES groups(id) ON DELETE SET NULL,
      relay_id    UUID,
      payload     JSONB,
      ip          VARCHAR(50),
      ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_el_ts       ON event_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_el_actor_id ON event_log(actor_id);
    CREATE INDEX IF NOT EXISTS idx_el_group_id ON event_log(group_id);
  `)

  await db.unsafe(`ALTER TABLE event_log ADD COLUMN IF NOT EXISTS relay_id UUID;`)

  // ── Триггер: удалять пользователей без групп ──────────────────
  await db.unsafe(`
    CREATE OR REPLACE FUNCTION auto_delete_orphan_user() RETURNS TRIGGER AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM user_groups WHERE user_id = OLD.user_id
      ) THEN
        DELETE FROM users
        WHERE id = OLD.user_id AND role = 'user';
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `)
  await db.unsafe(`
    DROP TRIGGER IF EXISTS trg_auto_delete_orphan_user ON user_groups;
    CREATE TRIGGER trg_auto_delete_orphan_user
      AFTER DELETE ON user_groups
      FOR EACH ROW EXECUTE FUNCTION auto_delete_orphan_user();
  `)

  // ── Суперадмин ────────────────────────────────────────────────
  const superadminLogin = process.env.SUPERADMIN_LOGIN || 'superadmin'
  const superadminPass  = process.env.SUPERADMIN_PASSWORD || 'changeme'
  const bcrypt = require('bcryptjs')
  const [existing] = await db`SELECT id FROM users WHERE role = 'superadmin' LIMIT 1`
  if (!existing) {
    const hash = await bcrypt.hash(superadminPass, 12)
    await db`
      INSERT INTO users (login, password_hash, role, must_change_password, single_session)
      VALUES (${superadminLogin}, ${hash}, 'superadmin', false, false)
    `
    console.log(`[db] Superadmin created: ${superadminLogin}`)
  }

  console.log('[db] Migration complete')
}

module.exports = { migrate }
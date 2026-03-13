'use strict'
/**
 * Scheduler — переходы состояний групп
 *
 * Каждый час:
 * 1. active + expires_at < NOW() → установить grace_until = expires_at + 30 дней, логировать
 * 2. grace_until < NOW() AND status = 'active' → status = 'blocked', blocked_at = NOW(), логировать
 * 3. blocked_at < NOW() - 6 месяцев → удалить устройства, эксклюзивных пользователей, status = 'deleted'
 */

const { getDb } = require('./db/connection')
const { deleteYcDevice } = require('./routes/device')

const INTERVAL_MS = 60 * 60 * 1000  // каждый час

async function runScheduler() {
  const db = getDb()
  const now = new Date()

  try {
    // ── 1. Запустить grace period ─────────────────────────────
    const expiredGroups = await db`
      SELECT id, name, expires_at
      FROM groups
      WHERE status     = 'active'
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
        AND grace_until IS NULL
    `
    for (const g of expiredGroups) {
      const graceUntil = new Date(new Date(g.expires_at).getTime() + 30 * 24 * 60 * 60 * 1000)
      await db`
        UPDATE groups
        SET grace_until = ${graceUntil}, updated_at = NOW()
        WHERE id = ${g.id}
      `
      await db`
        INSERT INTO event_log (action, target_type, target_id, payload)
        VALUES ('group_grace_started', 'group', ${g.id},
                ${{ name: g.name, expires_at: g.expires_at, grace_until: graceUntil }})
      `
      console.log(`[scheduler] Grace started: ${g.name} until ${graceUntil.toISOString()}`)
    }

    // ── 2. Заблокировать по истечении grace ───────────────────
    const graceExpired = await db`
      SELECT id, name
      FROM groups
      WHERE status      = 'active'
        AND grace_until IS NOT NULL
        AND grace_until < NOW()
    `
    for (const g of graceExpired) {
      await db`
        UPDATE groups
        SET status = 'blocked', blocked_at = NOW(), updated_at = NOW()
        WHERE id = ${g.id}
      `
      await db`
        INSERT INTO event_log (action, target_type, target_id, payload)
        VALUES ('group_blocked', 'group', ${g.id}, ${{ name: g.name }})
      `
      console.log(`[scheduler] Blocked: ${g.name}`)
    }

    // ── 3. Удалить через 6 месяцев после блокировки ───────────
    const toDelete = await db`
      SELECT id, name
      FROM groups
      WHERE status     = 'blocked'
        AND blocked_at IS NOT NULL
        AND blocked_at < NOW() - INTERVAL '6 months'
    `
    for (const g of toDelete) {
      await _deleteGroupData(db, g)
    }
  } catch (err) {
    console.error('[scheduler] Error:', err.message)
  }
}

async function _deleteGroupData(db, group) {
  console.log(`[scheduler] Deleting group data: ${group.name}`)

  // Удалить YC устройства
  const devices = await db`SELECT device_id, mqtt_user FROM devices WHERE group_id = ${group.id}`
  for (const d of devices) {
    if (d.mqtt_user) {
      try { await deleteYcDevice(d.mqtt_user) } catch (e) {
        console.warn(`[scheduler] YC delete error ${d.mqtt_user}: ${e.message}`)
      }
    }
    await db`DELETE FROM devices WHERE device_id = ${d.device_id}`
  }

  // Найти пользователей состоящих ТОЛЬКО в этой группе
  const exclusiveUsers = await db`
    SELECT ug.user_id
    FROM user_groups ug
    WHERE ug.group_id = ${group.id}
      AND NOT EXISTS (
        SELECT 1 FROM user_groups ug2
        WHERE ug2.user_id = ug.user_id
          AND ug2.group_id != ${group.id}
      )
      AND (SELECT role FROM users WHERE id = ug.user_id) != 'superadmin'
  `

  for (const u of exclusiveUsers) {
    await db`DELETE FROM users WHERE id = ${u.user_id}`
    console.log(`[scheduler] Deleted exclusive user: ${u.user_id}`)
  }

  await db`UPDATE groups SET status = 'deleted', updated_at = NOW() WHERE id = ${group.id}`

  await db`
    INSERT INTO event_log (action, target_type, target_id, payload)
    VALUES ('group_data_deleted', 'group', ${group.id},
            ${{ name: group.name, devices_deleted: devices.length, users_deleted: exclusiveUsers.length }})
  `
  console.log(`[scheduler] Done: ${group.name}, devices=${devices.length}, users=${exclusiveUsers.length}`)
}

function startScheduler() {
  console.log('[scheduler] Started (interval: 1h)')
  // Первый запуск через 1 минуту после старта
  setTimeout(() => {
    runScheduler()
    setInterval(runScheduler, INTERVAL_MS)
  }, 60 * 1000)
}

module.exports = { startScheduler }

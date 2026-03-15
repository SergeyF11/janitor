'use strict'
const { getDb } = require('../db/connection')

const GRACE_INTERVAL = "INTERVAL '1 month'"
const RETENTION_AFTER_GRACE = "INTERVAL '6 months'"

async function runGroupLifecycle() {
  const db = getDb()

  // 1) Активные группы с истёкшим сроком -> grace на 1 месяц
  await db.unsafe(`
    UPDATE groups
    SET status = 'grace',
        grace_until = COALESCE(grace_until, expires_at + ${GRACE_INTERVAL}),
        updated_at = NOW()
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
  `)

  // 2) Истёк grace -> blocked
  await db.unsafe(`
    UPDATE groups
    SET status = 'blocked',
        updated_at = NOW()
    WHERE status = 'grace'
      AND grace_until IS NOT NULL
      AND grace_until <= NOW()
  `)

  // 3) Через 6 месяцев после grace_until удалить группу и orphan user/admin
  const oldGroups = await db.unsafe(`
    SELECT id
    FROM groups
    WHERE grace_until IS NOT NULL
      AND grace_until + ${RETENTION_AFTER_GRACE} <= NOW()
  `)

  if (!oldGroups.length) return { deletedGroups: 0, deletedUsers: 0 }

  const groupIds = oldGroups.map((g) => g.id)

  const affectedUsers = await db`
    SELECT DISTINCT user_id
    FROM user_groups
    WHERE group_id = ANY(${groupIds}::uuid[])
  `

  await db`
    DELETE FROM groups
    WHERE id = ANY(${groupIds}::uuid[])
  `

  const userIds = affectedUsers.map((u) => u.user_id)
  if (!userIds.length) return { deletedGroups: groupIds.length, deletedUsers: 0 }

  const deletedUsers = await db`
    DELETE FROM users u
    WHERE u.id = ANY(${userIds}::uuid[])
      AND u.role IN ('user', 'admin')
      AND NOT EXISTS (SELECT 1 FROM user_groups ug WHERE ug.user_id = u.id)
    RETURNING id
  `

  return { deletedGroups: groupIds.length, deletedUsers: deletedUsers.length }
}

function startGroupLifecycleScheduler(intervalMs = 60 * 60 * 1000) {
  const run = async () => {
    try {
      const result = await runGroupLifecycle()
      if (result.deletedGroups || result.deletedUsers) {
        console.log(`[scheduler] lifecycle cleanup: groups=${result.deletedGroups}, users=${result.deletedUsers}`)
      }
    } catch (err) {
      console.error('[scheduler] lifecycle error:', err.message)
    }
  }

  run()
  const timer = setInterval(run, intervalMs)
  console.log(`[scheduler] Started (interval: ${Math.round(intervalMs / (60 * 1000))}m)`)
  return () => clearInterval(timer)
}

module.exports = { runGroupLifecycle, startGroupLifecycleScheduler }

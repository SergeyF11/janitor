'use strict'

const { getDb } = require('../db/connection')

async function logSystemEvent(db, action, groupId, payload = {}) {
  await db`
    INSERT INTO event_log (action, actor_login, target_type, target_id, group_id, payload)
    VALUES (${action}, 'system', 'group', ${groupId}, ${groupId}, ${payload})
  `
}

async function runGroupLifecycle() {
  const db = getDb()

  // 1) active -> grace (работают без ограничений еще 1 месяц)
  const movedToGrace = await db`
    UPDATE groups
    SET status = 'grace',
        grace_until = COALESCE(grace_until, expires_at + INTERVAL '1 month'),
        updated_at = NOW()
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
    RETURNING id, name, expires_at, grace_until
  `
  for (const group of movedToGrace) {
    await logSystemEvent(db, 'group_moved_to_grace', group.id, {
      name: group.name,
      expires_at: group.expires_at,
      grace_until: group.grace_until,
    })
  }

  // 2) grace -> blocked
  const movedToBlocked = await db`
    UPDATE groups
    SET status = 'blocked',
        blocked_at = COALESCE(blocked_at, NOW()),
        updated_at = NOW()
    WHERE status = 'grace'
      AND grace_until IS NOT NULL
      AND grace_until <= NOW()
    RETURNING id, name, grace_until, blocked_at
  `
  for (const group of movedToBlocked) {
    await logSystemEvent(db, 'group_blocked_by_lifecycle', group.id, {
      name: group.name,
      grace_until: group.grace_until,
      blocked_at: group.blocked_at,
    })
  }

  // 3) blocked > 6 months => удалить устройства и orphan пользователей/админов этой группы
  const cleanupGroups = await db`
    SELECT id, name, blocked_at
    FROM groups
    WHERE status = 'blocked'
      AND blocked_at IS NOT NULL
      AND blocked_at <= NOW() - INTERVAL '6 months'
  `

  for (const group of cleanupGroups) {
    const deletedDevices = await db`
      DELETE FROM devices
      WHERE group_id = ${group.id}
      RETURNING device_id
    `

    const orphanUsers = await db`
      DELETE FROM users u
      WHERE u.role IN ('user', 'admin')
        AND EXISTS (
          SELECT 1 FROM user_groups ug
          WHERE ug.user_id = u.id
            AND ug.group_id = ${group.id}
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_groups ug_other
          WHERE ug_other.user_id = u.id
            AND ug_other.group_id <> ${group.id}
        )
      RETURNING u.id, u.login, u.role
    `

    await db`DELETE FROM user_groups WHERE group_id = ${group.id}`

    await logSystemEvent(db, 'group_cleanup_after_block_6m', group.id, {
      group_name: group.name,
      blocked_at: group.blocked_at,
      deleted_devices: deletedDevices.map(d => d.device_id),
      deleted_users: orphanUsers.map(u => ({ id: u.id, login: u.login, role: u.role })),
    })
  }
}

function startGroupLifecycleJob(fastify) {
  const intervalMs = parseInt(process.env.GROUP_LIFECYCLE_INTERVAL_MS || '60000', 10)
  const timer = setInterval(async () => {
    try {
      await runGroupLifecycle()
    } catch (err) {
      fastify.log.error({ err }, 'group lifecycle job failed')
    }
  }, intervalMs)

  timer.unref?.()

  runGroupLifecycle().catch(err => {
    fastify.log.error({ err }, 'initial group lifecycle run failed')
  })

  fastify.addHook('onClose', async () => {
    clearInterval(timer)
  })
}

module.exports = {
  runGroupLifecycle,
  startGroupLifecycleJob,
}

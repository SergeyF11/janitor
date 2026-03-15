const DAY_MS = 24 * 60 * 60 * 1000

function getGroupLifecycle(group, nowTs = Date.now()) {
  const expTs = group.expires_at ? new Date(group.expires_at).getTime() : null
  const graceTs = group.grace_until ? new Date(group.grace_until).getTime() : null

  if (group.status === 'blocked') {
    return { type: 'blocked', days: 0 }
  }

  if (group.status === 'grace') {
    const days = graceTs ? Math.max(0, Math.ceil((graceTs - nowTs) / DAY_MS)) : 0
    return { type: 'grace', days }
  }

  if (expTs) {
    const daysToExpiry = Math.ceil((expTs - nowTs) / DAY_MS)
    if (daysToExpiry <= 30) {
      return { type: 'expiring', days: Math.max(0, daysToExpiry) }
    }
  }

  return null
}

export default function ExpiryWarning({ groups, compact = false }) {
  const now = Date.now()
  const warnings = (groups || [])
    .map((g) => ({ group: g, lifecycle: getGroupLifecycle(g, now) }))
    .filter((x) => !!x.lifecycle)

  if (!warnings.length) return null

  return (
    <div style={{ ...styles.container, gap: compact ? 4 : 8 }}>
      {warnings.map(({ group: g, lifecycle }) => {
        const isBlocked = lifecycle.type === 'blocked'
        const isGrace = lifecycle.type === 'grace'
        const color = isBlocked ? '#7b1c1c' : isGrace ? '#7b4c1c' : '#375a1f'

        let text
        if (isBlocked) {
          text = `Группа "${g.name}" заблокирована: истёк срок действия.`
        } else if (isGrace) {
          text = `Группа "${g.name}" в grace-периоде. До блокировки: ${lifecycle.days} дн.`
        } else {
          text = `Срок группы "${g.name}" истекает через ${lifecycle.days} дн.`
        }

        return (
          <div key={g.id} style={{ ...styles.banner, background: color, padding: compact ? '8px 10px' : '10px 16px' }}>
            <span style={styles.icon}>{isBlocked ? '🔒' : isGrace ? '⚠️' : '⏳'}</span>
            <span style={styles.text}>{text}</span>
          </div>
        )
      })}
    </div>
  )
}

export function isGroupBlocked(group) {
  return group?.status === 'blocked'
}

const styles = {
  container: { display: 'flex', flexDirection: 'column' },
  banner: { display: 'flex', alignItems: 'center', gap: '8px', borderRadius: 8 },
  icon: { fontSize: '18px' },
  text: { fontSize: '13px', color: '#ffecb3', lineHeight: 1.4 },
}

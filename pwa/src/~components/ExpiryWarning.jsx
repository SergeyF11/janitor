export default function ExpiryWarning({ groups = [] }) {
  const warnings = groups.filter(g => g.status === 'grace' || g.status === 'blocked')
  if (warnings.length === 0) return null

  const now = Date.now()
  const oneDay = 1000 * 60 * 60 * 24

  return (
    <div style={styles.container}>
      {warnings.map(g => {
        const isBlocked = g.status === 'blocked'
        const graceTs = g.grace_until ? new Date(g.grace_until).getTime() : null
        const daysLeft = graceTs ? Math.max(0, Math.ceil((graceTs - now) / oneDay)) : 0

        return (
          <div key={g.id} style={{ ...styles.banner, background: isBlocked ? '#7b1c1c' : '#7b4c1c' }}>
            <span style={styles.icon}>{isBlocked ? '🔒' : '⚠️'}</span>
            <span style={styles.text}>
              {isBlocked
                ? `Группа "${g.name}" заблокирована до назначения нового срока суперадмином.`
                : `Группа "${g.name}" в льготном периоде: ${daysLeft} дн. до блокировки.`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' },
  banner: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: 8 },
  icon: { fontSize: '18px' },
  text: { fontSize: '13px', color: '#ffcc80', lineHeight: 1.4 },
}

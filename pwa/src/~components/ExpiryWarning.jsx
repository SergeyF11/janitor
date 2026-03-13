export default function ExpiryWarning({ groups }) {
  const now = Date.now()

  // Найти группы в льготном периоде или заблокированные
  const warnings = groups.filter(g => g.status === 'grace' || g.status === 'blocked')

  if (warnings.length === 0) return null

  return (
    <div style={styles.container}>
      {warnings.map(g => {
        const isBlocked = g.status === 'blocked'
        const deadline = isBlocked ? null : new Date(g.grace_until)
        const daysLeft = deadline
          ? Math.ceil((deadline - now) / (1000 * 60 * 60 * 24))
          : 0

        return (
          <div key={g.id} style={{
            ...styles.banner,
            background: isBlocked ? '#7b1c1c' : '#7b4c1c'
          }}>
            <span style={styles.icon}>{isBlocked ? '🔒' : '⚠️'}</span>
            <span style={styles.text}>
              {isBlocked
                ? `"${g.name}" заблокирована. Обратитесь к администратору.`
                : `"${g.name}" будет заблокирована через ${daysLeft} дн.`
              }
            </span>
          </div>
        )
      })}
    </div>
  )
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
  },
  icon: { fontSize: '18px' },
  text: { fontSize: '13px', color: '#ffcc80', lineHeight: 1.4 },
}
import { useState } from 'react'
import axios from 'axios'

export default function ChangePassword({ onSuccess }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    setError('')
    if (password.length < 6) {
      setError('Пароль должен быть не менее 6 символов')
      return
    }
    if (password !== confirm) {
      setError('Пароли не совпадают')
      return
    }
    setLoading(true)
    try {
      const token = localStorage.getItem('token')
      const res = await axios.post('/janitor/api/auth/change-password',
        { new_password: password },
        { headers: { Authorization: `Bearer ${token}` } }
      )
      // Обновить токен — новый не содержит must_change_password
      localStorage.setItem('token', res.data.accessToken)
      onSuccess()
    } catch (err) {
      setError('Ошибка смены пароля')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.icon}>🔐</div>
        <h2 style={styles.title}>Смена пароля</h2>
        <p style={styles.subtitle}>
          Для продолжения необходимо задать новый пароль
        </p>

        <div style={styles.form}>
          <input
            style={styles.input}
            type="password"
            placeholder="Новый пароль (мин. 6 символов)"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Повторите пароль"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
          />

          {error && <p style={styles.error}>{error}</p>}

          <button
            style={{ ...styles.button, opacity: loading ? 0.7 : 1 }}
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? 'Сохраняю...' : 'Сохранить пароль'}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
  },
  card: {
    background: '#0f3460',
    borderRadius: '16px',
    padding: '40px 32px',
    width: '100%',
    maxWidth: '360px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '16px',
  },
  icon: { fontSize: '48px' },
  title: { fontSize: '22px', fontWeight: 'bold', color: '#eee' },
  subtitle: { fontSize: '14px', color: '#aaa', textAlign: 'center', lineHeight: 1.5 },
  form: { width: '100%', display: 'flex', flexDirection: 'column', gap: '12px' },
  input: {
    padding: '14px 16px',
    borderRadius: '8px',
    border: '1px solid #1a4a7a',
    background: '#16213e',
    color: '#eee',
    fontSize: '16px',
  },
  button: {
    padding: '16px',
    borderRadius: '8px',
    background: '#e94560',
    color: 'white',
    fontSize: '16px',
    fontWeight: 'bold',
  },
  error: { color: '#e94560', fontSize: '14px', textAlign: 'center' },
}
import { useState } from 'react'
import { login } from '../api'

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ login: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await login(form.login, form.password)
      // Сохранить токен и данные пользователя
      localStorage.setItem('token', res.data.accessToken)
      localStorage.setItem('user', JSON.stringify(res.data.user))
      onLogin(res.data.user)
    } catch (err) {
      setError('Неверный логин или пароль')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>🔑 Привратник</h1>
        <p style={styles.subtitle}>Система управления реле</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            style={styles.input}
            type="text"
            placeholder="Логин"
            value={form.login}
            onChange={e => setForm({ ...form, login: e.target.value })}
            autoCapitalize="none"
            autoComplete="username"
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Пароль"
            value={form.password}
            onChange={e => setForm({ ...form, password: e.target.value })}
            autoComplete="current-password"
          />

          {error && <p style={styles.error}>{error}</p>}

          <button
            style={{
              ...styles.button,
              opacity: loading ? 0.7 : 1
            }}
            type="submit"
            disabled={loading}
          >
            {loading ? 'Вхожу...' : 'Войти'}
          </button>
        </form>
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
  },
  title: {
    fontSize: '28px',
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: '8px',
    color: '#e94560',
  },
  subtitle: {
    textAlign: 'center',
    color: '#aaa',
    marginBottom: '32px',
    fontSize: '14px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  input: {
    padding: '14px 16px',
    borderRadius: '8px',
    border: '1px solid #1a4a7a',
    background: '#16213e',
    color: '#eee',
    fontSize: '16px',
    outline: 'none',
  },
  button: {
    padding: '16px',
    borderRadius: '8px',
    background: '#e94560',
    color: 'white',
    fontSize: '18px',
    fontWeight: 'bold',
    marginTop: '8px',
    transition: 'opacity 0.2s',
  },
  error: {
    color: '#e94560',
    textAlign: 'center',
    fontSize: '14px',
  }
}
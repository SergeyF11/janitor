import { useState, useEffect, useCallback } from 'react'
import {
  refreshOnStartup, setLogoutCallback, setAccessToken,
  cancelRefresh, getMe, login, logout
} from './api'
import SuperAdmin from './pages/SuperAdmin'
import './App.css'

// Отдельное приложение для /janitor/superadmin
// Доступно только для роли superadmin
export default function SuperAdminApp() {
  const [state, setState] = useState('loading')  // loading | login | app
  const [user, setUser]   = useState(null)
  const [form, setForm]   = useState({ login: '', password: '' })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleLogout = useCallback(() => {
    cancelRefresh()
    setAccessToken(null)
    setUser(null)
    setState('login')
  }, [])

  useEffect(() => {
    setLogoutCallback(handleLogout)

    refreshOnStartup().then(async (ok) => {
      if (ok) {
        try {
          const me = await getMe()
          if (me.role !== 'superadmin') {
            setState('login')
            return
          }
          setUser(me)
          setState('app')
        } catch {
          setState('login')
        }
      } else {
        setState('login')
      }
    })
  }, [handleLogout])

  async function handleLogin(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const data = await login(form.login, form.password)
      if (data.user.role !== 'superadmin') {
        await logout()
        setError('Доступ запрещён. Только для суперадминистратора.')
        return
      }
      setUser(data.user)
      setState('app')
    } catch (err) {
      if (err.message === 'session_exists') setError('Уже есть активная сессия.')
      else setError('Неверный логин или пароль.')
    } finally {
      setLoading(false)
    }
  }

  if (state === 'loading') {
    return (
      <div className="app-loading">
        <div className="spinner" />
      </div>
    )
  }

  if (state === 'app') {
    return <SuperAdmin user={user} onLogout={handleLogout} />
  }

  // Форма входа для суперадмина
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">⚙️</div>
        <h1 className="auth-title">Суперадмин</h1>
        <p className="auth-subtitle">Административная панель</p>

        <form onSubmit={handleLogin} className="auth-form">
          <div className="field">
            <label htmlFor="sa-login">Логин</label>
            <input
              id="sa-login"
              type="text"
              autoComplete="username"
              autoCapitalize="off"
              value={form.login}
              onChange={e => setForm(f => ({ ...f, login: e.target.value }))}
              disabled={loading}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="sa-password">Пароль</label>
            <input
              id="sa-password"
              type="password"
              autoComplete="current-password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              disabled={loading}
              required
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>

        <div style={{ marginTop: '20px', textAlign: 'center' }}>
          <a href="/janitor/" style={{ fontSize: '13px', color: 'var(--text2)' }}>
            ← Обычный вход
          </a>
        </div>
      </div>
    </div>
  )
}
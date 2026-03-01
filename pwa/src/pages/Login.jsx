import { useState } from 'react'
import { login } from '../api'

export default function Login({ onSuccess }) {
  const [form, setForm]       = useState({ login: '', password: '' })
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const data = await login(form.login, form.password)
      onSuccess(data)
    } catch (err) {
      if (err.message === 'session_exists') {
        setError('Уже есть активная сессия. Выйдите на другом устройстве.')
      } else if (err.message === 'user_inactive') {
        setError('Аккаунт заблокирован.')
      } else {
        setError('Неверный логин или пароль.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">🔑</div>
        <h1 className="auth-title">Привратник</h1>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="field">
            <label htmlFor="login">Логин</label>
            <input
              id="login"
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
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
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
      </div>
    </div>
  )
}
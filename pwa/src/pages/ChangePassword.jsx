import { useState } from 'react'
import { changePassword, setAccessToken } from '../api'

export default function ChangePassword({ user, onSuccess }) {
  const [form, setForm]       = useState({ password: '', confirm: '' })
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (form.password !== form.confirm) {
      setError('Пароли не совпадают.')
      return
    }
    if (form.password.length < 6) {
      setError('Минимум 6 символов.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const data = await changePassword(form.password)
      // Обновить access token из ответа
      if (data.accessToken) setAccessToken(data.accessToken)
      onSuccess(data)
    } catch (err) {
      setError('Ошибка при смене пароля. Попробуйте ещё раз.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">🔐</div>
        <h1 className="auth-title">Смена пароля</h1>
        <p className="auth-subtitle">
          Привет, <strong>{user?.login}</strong>!<br/>
          Для продолжения задайте новый пароль.
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="field">
            <label htmlFor="password">Новый пароль</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              disabled={loading}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="confirm">Повторите пароль</label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))}
              disabled={loading}
              required
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? 'Сохранение...' : 'Сохранить пароль'}
          </button>
        </form>
      </div>
    </div>
  )
}
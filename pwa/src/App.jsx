import { useState } from 'react'
import Login from './pages/Login'
import Main from './pages/Main'
import Admin from './pages/Admin'
import SuperAdmin from './pages/SuperAdmin'
import ChangePassword from './pages/ChangePassword'
import { logout } from './api'

export default function App() {
  const savedUser = localStorage.getItem('user')
  const [user, setUser] = useState(savedUser ? JSON.parse(savedUser) : null)
  const [page, setPage] = useState('main')

  const handleLogin = (userData) => {
    localStorage.setItem('user', JSON.stringify(userData))
    setUser(userData)
    setPage('main')
  }

const handleLogout = async () => {
    try {
      await logout()
    } catch (e) {
      // игнорируем ошибки при выходе
    }
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
    setPage('main')
  }

  const handlePasswordChanged = () => {
    // Обновить user в state — убрать флаг must_change_password
    const updated = { ...user, must_change_password: false }
    localStorage.setItem('user', JSON.stringify(updated))
    setUser(updated)
  }

  if (!user) return <Login onLogin={handleLogin} />

  // Обязательная смена пароля
  if (user.must_change_password) {
    return <ChangePassword onSuccess={handlePasswordChanged} />
  }

  if (page === 'admin') return (
    <Admin user={user} onBack={() => setPage('main')} />
  )

  if (page === 'superadmin') return (
    <SuperAdmin user={user} onBack={() => setPage('main')} />
  )

  return (
    <Main
      user={user}
      onLogout={handleLogout}
      onAdminTab={() => setPage('admin')}
      onSuperAdminTab={() => setPage('superadmin')}
    />
  )
}
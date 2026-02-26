import { useState } from 'react'
import Login from './pages/Login'
import Main from './pages/Main'
import Admin from './pages/Admin'

export default function App() {
  // Читаем сохранённого пользователя из localStorage
  const savedUser = localStorage.getItem('user')
  const [user, setUser] = useState(savedUser ? JSON.parse(savedUser) : null)
  const [page, setPage] = useState('main') // 'main' | 'admin'

  const handleLogin = (userData) => {
    setUser(userData)
    setPage('main')
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
    setPage('main')
  }

  // Не авторизован — показать логин
  if (!user) {
    return <Login onLogin={handleLogin} />
  }

  // Страница администратора
  if (page === 'admin') {
    return (
      <Admin
        user={user}
        onBack={() => setPage('main')}
      />
    )
  }

  // Главная страница с кнопками
  return (
    <Main
      user={user}
      onLogout={handleLogout}
      onAdminTab={() => setPage('admin')}
    />
  )
}
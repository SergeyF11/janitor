import { useState, useEffect, useCallback } from 'react'
import {
  refreshOnStartup, setLogoutCallback, setAccessToken,
  cancelRefresh, getMe
} from './api'
import Login from './pages/Login'
import ChangePassword from './pages/ChangePassword'
import Main from './pages/Main'
import SuperAdmin from './pages/SuperAdmin'
import './App.css'

export default function App() {
  const [state, setState]   = useState('loading')  // loading | login | change_password | main | superadmin
  const [user, setUser]     = useState(null)
  const [error, setError]   = useState(null)

  const handleLogout = useCallback(() => {
    cancelRefresh()
    setAccessToken(null)
    setUser(null)
    setState('login')
  }, [])

  useEffect(() => {
    setLogoutCallback(handleLogout)

    // Попытаться восстановить сессию при загрузке
    refreshOnStartup().then(async (ok) => {
      if (ok) {
        try {
          const me = await getMe()
          setUser(me)
          if (me.must_change_password) {
            setState('change_password')
          } else if (me.role === 'superadmin') {
            setState('superadmin')
          } else {
            setState('main')
          }
        } catch {
          setState('login')
        }
      } else {
        setState('login')
      }
    })
  }, [handleLogout])

  const handleLoginSuccess = useCallback((data) => {
    setUser(data.user)
    setError(null)
    if (data.user.must_change_password) {
      setState('change_password')
    } else if (data.user.role === 'superadmin') {
      setState('superadmin')
    } else {
      setState('main')
    }
  }, [])

  const handlePasswordChanged = useCallback((data) => {
    setUser(data.user)
    if (data.user.role === 'superadmin') {
      setState('superadmin')
    } else {
      setState('main')
    }
  }, [])

  if (state === 'loading') {
    return (
      <div className="app-loading">
        <div className="spinner" />
      </div>
    )
  }

  if (state === 'login') {
    return <Login onSuccess={handleLoginSuccess} />
  }

  if (state === 'change_password') {
    return <ChangePassword user={user} onSuccess={handlePasswordChanged} />
  }

  if (state === 'superadmin') {
    return <SuperAdmin user={user} onLogout={handleLogout} />
  }

  return <Main user={user} onLogout={handleLogout} />
}
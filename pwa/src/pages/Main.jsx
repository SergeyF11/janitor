import { useState, useEffect, useRef } from 'react'
import { getMyGroups } from '../api'
import ButtonGrid from '../components/ButtonGrid'
import ExpiryWarning from '../components/ExpiryWarning'

export default function Main({ user, onLogout, onAdminTab, onSuperAdminTab  }) {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const wsRef = useRef(null)

  // Загрузить группы при открытии страницы
  useEffect(() => {
    loadGroups()
    connectWebSocket()

    return () => {
      // Отключить WebSocket при уходе со страницы
      if (wsRef.current) wsRef.current.close()
    }
  }, [])

  const loadGroups = async () => {
    try {
      const res = await getMyGroups()
      setGroups(res.data)
    } catch (err) {
      setError('Не удалось загрузить группы')
    } finally {
      setLoading(false)
    }
  }

  // WebSocket для получения статусов реле в реальном времени
  const connectWebSocket = () => {
    const token = localStorage.getItem('token')
    const wsUrl = `wss://smilart.ru/janitor/ws?token=${token}`

    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'relay_status') {
          // Обновить состояние конкретной группы
          setGroups(prev => prev.map(g =>
            g.mqtt_topic === data.topic
              ? { ...g, relay_state: data.state === 'on' }
              : g
          ))
        }
      }

      ws.onerror = () => {
        // Тихая ошибка — кнопки работают и без WebSocket
        console.log('WebSocket недоступен')
      }
    } catch (e) {
      console.log('WebSocket не поддерживается')
    }
  }

  // Обновить состояние кнопки после нажатия
  const handleStateChange = (groupId, newState) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, relay_state: newState } : g
    ))
  }

  const isAdmin = user.role === 'admin' || user.role === 'superadmin'

  return (
    <div style={styles.container}>
      {/* Шапка */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>🔑 Привратник</span>
        <div style={styles.headerRight}>
          {user.role === 'superadmin' && (
            <button style={styles.adminBtn} onClick={onSuperAdminTab}>
              👑
            </button>
          )}
          {(user.role === 'admin' || user.role === 'superadmin') && (
            <button style={styles.adminBtn} onClick={onAdminTab}>
              ⚙️
            </button>
          )}
          <button style={styles.logoutBtn} onClick={onLogout}>
            Выйти
          </button>
        </div>
      </div>

      {/* Предупреждения о сроке */}
      <ExpiryWarning groups={groups} />

      {/* Основная область с кнопками */}
      <div style={styles.content}>
        {loading && (
          <div style={styles.center}>
            <p>Загрузка...</p>
          </div>
        )}

        {error && (
          <div style={styles.center}>
            <p style={{ color: '#e94560' }}>{error}</p>
            <button style={styles.retryBtn} onClick={loadGroups}>
              Повторить
            </button>
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div style={styles.center}>
            <p style={{ color: '#aaa' }}>Нет доступных каналов</p>
          </div>
        )}

        {/* Все группы заблокированы */}
        {!loading && !error && groups.length > 0 &&
         groups.every(g => g.status === 'blocked') && (
          <div style={styles.blocked}>
            <span style={{ fontSize: '64px' }}>🔒</span>
            <h2 style={styles.blockedTitle}>Доступ заблокирован</h2>
            <p style={styles.blockedText}>
              Срок действия истёк.{'\n'}Обратитесь к администратору.
            </p>
          </div>
        )}

        {!loading && !error && groups.length > 0 &&
         !groups.every(g => g.status === 'blocked') && (
          <ButtonGrid
            groups={groups.filter(g => g.status !== 'blocked')}
            onStateChange={handleStateChange}
          />
        )}
      </div>
    </div>
  )
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    background: '#0f3460',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    minHeight: '56px',
  },
  headerTitle: {
    fontSize: '18px',
    fontWeight: 'bold',
    color: '#e94560',
  },
  headerRight: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  adminBtn: {
    background: '#1a4a7a',
    color: 'white',
    padding: '8px 12px',
    borderRadius: '8px',
    fontSize: '18px',
  },
  logoutBtn: {
    background: 'transparent',
    color: '#aaa',
    padding: '8px 12px',
    borderRadius: '8px',
    fontSize: '14px',
    border: '1px solid #333',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  center: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
  },
  retryBtn: {
    background: '#e94560',
    color: 'white',
    padding: '10px 24px',
    borderRadius: '8px',
    fontSize: '16px',
  },
  blocked: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '32px',
    textAlign: 'center',
  },
  blockedTitle: {
    fontSize: '22px',
    fontWeight: 'bold',
    color: '#e94560',
  },
  blockedText: {
    fontSize: '16px',
    color: '#aaa',
    lineHeight: 1.6,
    whiteSpace: 'pre-line',
  },
}
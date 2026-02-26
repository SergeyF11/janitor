import { useState, useEffect } from 'react'
import {
  getAdminGroups,
  getGroupUsers,
  addUserToGroup,
  removeUserFromGroup,
  getGroupLogs
} from '../api'

export default function Admin({ user, onBack }) {
  const [groups, setGroups] = useState([])
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [users, setUsers] = useState([])
  const [logs, setLogs] = useState([])
  const [tab, setTab] = useState('users') // 'users' | 'logs'
  const [loading, setLoading] = useState(true)
  const [showAddUser, setShowAddUser] = useState(false)
  const [newUser, setNewUser] = useState({ login: '', password: '', role: 'user' })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    loadGroups()
  }, [])

  useEffect(() => {
    if (selectedGroup) {
      loadUsers(selectedGroup.id)
      loadLogs(selectedGroup.id)
    }
  }, [selectedGroup])

  const loadGroups = async () => {
    try {
      const res = await getAdminGroups()
      setGroups(res.data)
      if (res.data.length > 0) setSelectedGroup(res.data[0])
    } catch (err) {
      setError('Не удалось загрузить группы')
    } finally {
      setLoading(false)
    }
  }

  const loadUsers = async (groupId) => {
    try {
      const res = await getGroupUsers(groupId)
      setUsers(res.data)
    } catch (err) {
      setError('Не удалось загрузить пользователей')
    }
  }

  const loadLogs = async (groupId) => {
    try {
      const res = await getGroupLogs(groupId)
      setLogs(res.data)
    } catch (err) {
      console.log('Ошибка загрузки логов')
    }
  }

  const handleAddUser = async () => {
    if (!newUser.login || !newUser.password) {
      setError('Заполните логин и пароль')
      return
    }
    setError('')
    try {
      await addUserToGroup(selectedGroup.id, newUser.login, newUser.password, newUser.role)
      setSuccess(`Пользователь ${newUser.login} добавлен`)
      setNewUser({ login: '', password: '', role: 'user' })
      setShowAddUser(false)
      loadUsers(selectedGroup.id)
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError('Ошибка при добавлении пользователя')
    }
  }

  const handleRemoveUser = async (userId, login) => {
    if (!confirm(`Удалить ${login} из группы?`)) return
    try {
      await removeUserFromGroup(selectedGroup.id, userId)
      loadUsers(selectedGroup.id)
    } catch (err) {
      setError('Ошибка при удалении')
    }
  }

  const formatDate = (ts) => {
    const d = new Date(ts)
    return d.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
  }

  if (loading) return (
    <div style={styles.container}>
      <div style={styles.center}><p>Загрузка...</p></div>
    </div>
  )

  return (
    <div style={styles.container}>

      {/* Шапка */}
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={onBack}>← Назад</button>
        <span style={styles.headerTitle}>⚙️ Администрирование</span>
      </div>

      {/* Выбор группы */}
      {groups.length > 1 && (
        <div style={styles.groupSelector}>
          {groups.map(g => (
            <button
              key={g.id}
              style={{
                ...styles.groupBtn,
                background: selectedGroup?.id === g.id ? '#e94560' : '#1a4a7a'
              }}
              onClick={() => setSelectedGroup(g)}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {/* Вкладки */}
      <div style={styles.tabs}>
        <button
          style={{ ...styles.tab, borderBottom: tab === 'users' ? '2px solid #e94560' : 'none' }}
          onClick={() => setTab('users')}
        >
          👥 Пользователи
        </button>
        <button
          style={{ ...styles.tab, borderBottom: tab === 'logs' ? '2px solid #e94560' : 'none' }}
          onClick={() => setTab('logs')}
        >
          📋 Журнал
        </button>
      </div>

      {/* Сообщения */}
      {error && <p style={styles.error}>{error}</p>}
      {success && <p style={styles.success}>{success}</p>}

      {/* Содержимое */}
      <div style={styles.content}>

        {/* Вкладка пользователей */}
        {tab === 'users' && (
          <div style={styles.section}>
            <button
              style={styles.addBtn}
              onClick={() => setShowAddUser(!showAddUser)}
            >
              {showAddUser ? '✕ Отмена' : '+ Добавить пользователя'}
            </button>

            {/* Форма добавления */}
            {showAddUser && (
              <div style={styles.addForm}>
                <input
                  style={styles.input}
                  placeholder="Логин"
                  value={newUser.login}
                  onChange={e => setNewUser({ ...newUser, login: e.target.value })}
                  autoCapitalize="none"
                />
                <input
                  style={styles.input}
                  type="password"
                  placeholder="Пароль"
                  value={newUser.password}
                  onChange={e => setNewUser({ ...newUser, password: e.target.value })}
                />
                <select
                  style={styles.input}
                  value={newUser.role}
                  onChange={e => setNewUser({ ...newUser, role: e.target.value })}
                >
                  <option value="user">Пользователь</option>
                  <option value="admin">Администратор</option>
                </select>
                <button style={styles.saveBtn} onClick={handleAddUser}>
                  Сохранить
                </button>
              </div>
            )}

            {/* Список пользователей */}
            <div style={styles.list}>
              {users.map(u => (
                <div key={u.id} style={styles.userRow}>
                  <div>
                    <span style={styles.userName}>{u.login}</span>
                    <span style={{
                      ...styles.roleTag,
                      background: u.role === 'admin' ? '#e94560' : '#1a4a7a'
                    }}>
                      {u.role === 'admin' ? 'Админ' : 'Польз.'}
                    </span>
                  </div>
                  {u.id !== user.id && (
                    <button
                      style={styles.removeBtn}
                      onClick={() => handleRemoveUser(u.id, u.login)}
                    >
                      🗑️
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Вкладка журнала */}
        {tab === 'logs' && (
          <div style={styles.section}>
            <div style={styles.list}>
              {logs.length === 0 && (
                <p style={{ color: '#aaa', textAlign: 'center', padding: '20px' }}>
                  Журнал пуст
                </p>
              )}
              {logs.map(log => (
                <div key={log.id} style={styles.logRow}>
                  <span style={styles.logTime}>{formatDate(log.ts)}</span>
                  <span style={styles.logUser}>{log.user_login}</span>
                  <span style={styles.logAction}>{log.action}</span>
                </div>
              ))}
            </div>
          </div>
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
    gap: '12px',
    padding: '12px 16px',
    background: '#0f3460',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    minHeight: '56px',
  },
  headerTitle: {
    fontSize: '16px',
    fontWeight: 'bold',
    color: '#eee',
  },
  backBtn: {
    background: 'transparent',
    color: '#e94560',
    fontSize: '16px',
    padding: '4px 8px',
    borderRadius: '8px',
  },
  groupSelector: {
    display: 'flex',
    gap: '8px',
    padding: '12px 16px',
    overflowX: 'auto',
    background: '#16213e',
  },
  groupBtn: {
    padding: '8px 16px',
    borderRadius: '20px',
    color: 'white',
    fontSize: '14px',
    whiteSpace: 'nowrap',
  },
  tabs: {
    display: 'flex',
    background: '#16213e',
    borderBottom: '1px solid #1a4a7a',
  },
  tab: {
    flex: 1,
    padding: '12px',
    background: 'transparent',
    color: '#eee',
    fontSize: '14px',
    borderRadius: 0,
  },
  content: {
    flex: 1,
    overflowY: 'auto',
  },
  section: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  addBtn: {
    background: '#1a4a7a',
    color: 'white',
    padding: '12px',
    borderRadius: '8px',
    fontSize: '15px',
    width: '100%',
  },
  addForm: {
    background: '#0f3460',
    borderRadius: '12px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  input: {
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid #1a4a7a',
    background: '#16213e',
    color: '#eee',
    fontSize: '15px',
  },
  saveBtn: {
    background: '#e94560',
    color: 'white',
    padding: '12px',
    borderRadius: '8px',
    fontSize: '15px',
    fontWeight: 'bold',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  userRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: '#0f3460',
    borderRadius: '10px',
    padding: '12px 16px',
  },
  userName: {
    fontSize: '15px',
    marginRight: '8px',
  },
  roleTag: {
    fontSize: '11px',
    padding: '2px 8px',
    borderRadius: '10px',
    color: 'white',
  },
  removeBtn: {
    background: 'transparent',
    fontSize: '18px',
    padding: '4px',
  },
  logRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    background: '#0f3460',
    borderRadius: '10px',
    padding: '10px 12px',
    flexWrap: 'wrap',
  },
  logTime: {
    fontSize: '12px',
    color: '#aaa',
    whiteSpace: 'nowrap',
  },
  logUser: {
    fontSize: '13px',
    color: '#e94560',
    fontWeight: 'bold',
  },
  logAction: {
    fontSize: '13px',
    color: '#eee',
  },
  error: {
    color: '#e94560',
    padding: '8px 16px',
    fontSize: '14px',
  },
  success: {
    color: '#27ae60',
    padding: '8px 16px',
    fontSize: '14px',
  },
  center: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
}
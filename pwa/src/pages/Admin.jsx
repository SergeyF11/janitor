import { useState, useEffect, useCallback } from 'react'
import {
  getAdminGroups, getGroupUsers, createUser, addUserById,
  updateUserDescription, removeUserFromGroup, resetUserSessions,
  updateSingleSession, getGroupDevice, generateDeviceToken,
  getGroupLogs, logout
} from '../api'

export default function Admin({ user, onLogout }) {
  const [groups, setGroups]         = useState([])
  const [selected, setSelected]     = useState(null)  // выбранная группа
  const [tab, setTab]               = useState('users')  // users | device | logs
  const [users, setUsers]           = useState([])
  const [device, setDevice]         = useState(null)
  const [logs, setLogs]             = useState([])
  const [loading, setLoading]       = useState(true)
  const [showAddUser, setShowAddUser] = useState(false)
  const [addMode, setAddMode]       = useState('new')  // new | existing
  const [newUser, setNewUser]       = useState({ login: '', password: '', role: 'user', description: '', single_session: true })
  const [existingUser, setExistingUser] = useState({ user_id: '', description: '' })
  const [addError, setAddError]     = useState(null)
  const [saving, setSaving]         = useState(false)

  const loadGroups = useCallback(async () => {
    try {
      const g = await getAdminGroups()
      setGroups(g)
      if (g.length > 0 && !selected) setSelected(g[0])
    } catch {}
    setLoading(false)
  }, [selected])

  useEffect(() => { loadGroups() }, [])

  const loadTabData = useCallback(async () => {
    if (!selected) return
    if (tab === 'users') {
      const u = await getGroupUsers(selected.id)
      setUsers(u)
    } else if (tab === 'device') {
      const d = await getGroupDevice(selected.id)
      setDevice(d)
    } else if (tab === 'logs') {
      const l = await getGroupLogs(selected.id)
      setLogs(l)
    }
  }, [selected, tab])

  useEffect(() => { loadTabData() }, [loadTabData])

  async function handleAddUser(e) {
    e.preventDefault()
    setAddError(null)
    setSaving(true)
    try {
      if (addMode === 'new') {
        await createUser(selected.id, newUser)
        setNewUser({ login: '', password: '', role: 'user', description: '', single_session: true })
      } else {
        await addUserById(selected.id, existingUser.user_id.trim(), existingUser.description)
        setExistingUser({ user_id: '', description: '' })
      }
      setShowAddUser(false)
      loadTabData()
    } catch (err) {
      if (err.message === 'login_taken')      setAddError('Логин уже занят.')
      else if (err.message === 'already_in_group') setAddError('Пользователь уже в группе.')
      else if (err.message === 'user_not_found')   setAddError('Пользователь не найден.')
      else if (err.message === 'quota_exceeded')   setAddError(err.body?.message || 'Квота исчерпана.')
      else setAddError('Ошибка. Попробуйте ещё раз.')
    } finally {
      setSaving(false)
    }
  }

  async function handleRemoveUser(userId) {
    if (!confirm('Удалить пользователя из группы?')) return
    await removeUserFromGroup(selected.id, userId)
    loadTabData()
  }

  async function handleResetSession(userId) {
    await resetUserSessions(userId)
    loadTabData()
  }

  async function handleToggleSingleSession(userId, current) {
    await updateSingleSession(userId, !current)
    loadTabData()
  }

  async function handleGenerateToken() {
    const result = await generateDeviceToken(selected.id)
    setDevice(d => ({ ...d, pending_code: result.code, code_expires_at: result.expires_at }))
  }

  async function handleLogout() {
    await logout()
    onLogout()
  }

  if (loading) return <div className="app-loading"><div className="spinner" /></div>

  return (
    <div className="admin-screen">
      {/* Шапка */}
      <header className="admin-header">
        <h1 className="admin-title">Управление</h1>
        <div className="admin-header-right">
          <span className="admin-login">{user.login}</span>
          <button className="btn btn-outline btn-sm" onClick={handleLogout}>Выйти</button>
        </div>
      </header>

      <div className="admin-layout">
        {/* Список групп */}
        <aside className="groups-sidebar">
          <div className="sidebar-title">Группы</div>
          {groups.map(g => (
            <button
              key={g.id}
              className={`sidebar-item ${selected?.id === g.id ? 'active' : ''}`}
              onClick={() => { setSelected(g); setTab('users') }}
            >
              <span className="sidebar-item-name">{g.name}</span>
              <span className="sidebar-item-count">{g.user_count}</span>
            </button>
          ))}
        </aside>

        {/* Контент */}
        <main className="admin-content">
          {!selected ? (
            <div className="empty-state">Выберите группу</div>
          ) : (
            <>
              <div className="content-header">
                <h2 className="content-title">{selected.name}</h2>
              </div>

              {/* Табы */}
              <div className="tabs">
                {['users', 'device', 'logs'].map(t => (
                  <button
                    key={t}
                    className={`tab ${tab === t ? 'active' : ''}`}
                    onClick={() => setTab(t)}
                  >
                    {{ users: 'Пользователи', device: 'Устройство', logs: 'Журнал' }[t]}
                  </button>
                ))}
              </div>

              {/* ── Пользователи ── */}
              {tab === 'users' && (
                <div className="tab-content">
                  <div className="tab-toolbar">
                    <button className="btn btn-primary btn-sm" onClick={() => setShowAddUser(v => !v)}>
                      {showAddUser ? 'Отмена' : '+ Добавить'}
                    </button>
                  </div>

                  {/* Форма добавления */}
                  {showAddUser && (
                    <div className="add-user-panel">
                      <div className="mode-toggle">
                        <button className={`mode-btn ${addMode === 'new' ? 'active' : ''}`}
                                onClick={() => setAddMode('new')}>Новый</button>
                        <button className={`mode-btn ${addMode === 'existing' ? 'active' : ''}`}
                                onClick={() => setAddMode('existing')}>По ID</button>
                      </div>

                      <form onSubmit={handleAddUser} className="add-user-form">
                        {addMode === 'new' ? (
                          <>
                            <div className="field-row">
                              <div className="field">
                                <label>Логин</label>
                                <input value={newUser.login}
                                       onChange={e => setNewUser(u => ({ ...u, login: e.target.value }))}
                                       required />
                              </div>
                              <div className="field">
                                <label>Пароль</label>
                                <input type="password" value={newUser.password}
                                       onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
                                       required minLength={6} />
                              </div>
                            </div>
                            <div className="field-row">
                              <div className="field">
                                <label>Роль</label>
                                <select value={newUser.role}
                                        onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))}>
                                  <option value="user">Пользователь</option>
                                  <option value="admin">Администратор</option>
                                </select>
                              </div>
                              {newUser.role === 'admin' && (
                                <div className="field field-checkbox">
                                  <label>
                                    <input type="checkbox" checked={newUser.single_session}
                                           onChange={e => setNewUser(u => ({ ...u, single_session: e.target.checked }))} />
                                    Одна сессия
                                  </label>
                                </div>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="field">
                            <label>ID пользователя</label>
                            <input
                              value={existingUser.user_id}
                              onChange={e => setExistingUser(u => ({ ...u, user_id: e.target.value }))}
                              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                              required
                            />
                          </div>
                        )}

                        <div className="field">
                          <label>Описание в группе</label>
                          <input
                            value={addMode === 'new' ? newUser.description : existingUser.description}
                            onChange={e => addMode === 'new'
                              ? setNewUser(u => ({ ...u, description: e.target.value }))
                              : setExistingUser(u => ({ ...u, description: e.target.value }))
                            }
                            placeholder="Необязательно"
                          />
                        </div>

                        {addError && <div className="form-error">{addError}</div>}

                        <button type="submit" className="btn btn-primary" disabled={saving}>
                          {saving ? 'Сохранение...' : 'Добавить'}
                        </button>
                      </form>
                    </div>
                  )}

                  {/* Список пользователей */}
                  <div className="users-list">
                    {users.length === 0 && <div className="empty-state">Нет пользователей</div>}
                    {users.map(u => (
                      <div key={u.id} className="user-card">
                        <div className="user-card-main">
                          <div className="user-info">
                            <span className="user-login">{u.login}</span>
                            <span className={`user-role role-${u.role}`}>{u.role}</span>
                            {u.has_session && <span className="session-dot" title="Есть активная сессия">●</span>}
                            {!u.is_active && <span className="badge-inactive">неактивен</span>}
                          </div>
                          {u.description && <div className="user-description">{u.description}</div>}
                          {u.display_name && <div className="user-display-name">{u.display_name}</div>}
                        </div>

                        <div className="user-card-actions">
                          {u.has_session && (
                            <button className="btn btn-outline btn-xs"
                                    onClick={() => handleResetSession(u.id)}
                                    title="Сбросить сессию">
                              ⏏ Сессия
                            </button>
                          )}
                          {u.role !== 'superadmin' && (
                            <button
                              className={`btn btn-xs ${u.single_session ? 'btn-warning' : 'btn-outline'}`}
                              onClick={() => handleToggleSingleSession(u.id, u.single_session)}
                              title={u.single_session ? 'Одна сессия (нажать чтобы снять)' : 'Несколько сессий'}
                            >
                              {u.single_session ? '🔒 1 сессия' : '🔓 мульти'}
                            </button>
                          )}
                          <button className="btn btn-danger btn-xs"
                                  onClick={() => handleRemoveUser(u.id)}>
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Устройство ── */}
              {tab === 'device' && (
                <div className="tab-content">
                  {device?.device_id ? (
                    <div className="device-info">
                      <div className="device-status">
                        <span className={`device-dot-lg ${device.is_online ? 'online' : 'offline'}`} />
                        <span>{device.is_online ? 'Онлайн' : 'Оффлайн'}</span>
                      </div>
                      <div className="device-details">
                        <div><b>ID:</b> <code>{device.device_id}</code></div>
                        <div><b>Прошивка:</b> {device.fw_version || '—'}</div>
                        <div><b>Последний раз:</b> {device.last_seen
                          ? new Date(device.last_seen).toLocaleString('ru')
                          : '—'}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="empty-state">Устройство не привязано</div>
                  )}

                  <div className="device-token-section">
                    <div className="section-title">Привязка ESP устройства</div>
                    {device?.pending_code ? (
                      <div className="token-display">
                        <div className="token-code">{device.pending_code}</div>
                        <div className="token-hint">
                          Введите этот код в CaptivePortal устройства.<br/>
                          Действует до {new Date(device.code_expires_at).toLocaleString('ru')}
                        </div>
                      </div>
                    ) : (
                      <button className="btn btn-primary" onClick={handleGenerateToken}>
                        Сгенерировать код привязки
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── Журнал ── */}
              {tab === 'logs' && (
                <div className="tab-content">
                  <div className="logs-list">
                    {logs.length === 0 && <div className="empty-state">Нет событий</div>}
                    {logs.map(l => (
                      <div key={l.id} className="log-entry">
                        <span className="log-ts">{new Date(l.ts).toLocaleString('ru')}</span>
                        <span className="log-actor">{l.actor_login || '—'}</span>
                        <span className={`log-action action-${l.action}`}>{l.action}</span>
                        {l.payload && (
                          <span className="log-payload">
                            {JSON.stringify(l.payload).substring(0, 60)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getMyGroups, getMyProfile, triggerRelay, logout, createWsConnection,
  getGroupUsers, getAdminUsers, createUser, addUserById, importUsersFromGroup,
  removeUserFromGroup, resetUserSessions, updateSingleSession, adminResetUserPassword,
  getGroupDevice, generateDeviceToken, adminTriggerRelay,
  getGroupLogs, updateUserDescription,
  mqttConnect, mqttDisconnect, isMqttConnected,
} from '../api'

export default function Main({ user, onLogout }) {
  const [groups, setGroups]           = useState([])
  const [profile, setProfile]         = useState(null)
  const [loading, setLoading]         = useState(true)
  const [pressing, setPressing]       = useState({})
  const [statuses, setStatuses]       = useState({})
  const [showProfile, setShowProfile] = useState(false)
  const [settingsGroup, setSettingsGroup] = useState(null)
  const [mqttOnline, setMqttOnline]   = useState(false)
  const wsRef = useRef(null)

  const isAdmin = user?.role === 'admin'
  const canPress = (group) => mqttOnline || navigator.onLine

  const loadData = useCallback(async () => {
    try {
      const [g, p] = await Promise.all([getMyGroups(), getMyProfile()])
      setGroups(g)
      setProfile(p)
      const init = {}
      g.forEach(gr => {
        init[gr.mqtt_topic] = {
          state:  gr.relay_state || 'off',
          online: gr.device_online || false,
        }
      })
      setStatuses(init)
    } catch (err) {
      console.error('load error', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()

    // WebSocket — статусы реле и устройств от бэкенда (если доступен)
    const ws = createWsConnection((msg) => {
      if (msg.type === 'relay_status') {
        setStatuses(s => ({ ...s, [msg.topic]: { ...s[msg.topic], state: msg.state } }))
      }
      if (msg.type === 'device_status') {
        setGroups(g => g.map(gr =>
          gr.device_id === msg.device_id ? { ...gr, device_online: msg.online } : gr
        ))
      }
    })
    wsRef.current = ws

    // MQTT — прямое подключение для кнопок
    mqttConnect((connected) => setMqttOnline(connected))

    return () => {
      ws.close()
      mqttDisconnect()
    }
  }, [loadData])

  async function handleTrigger(group) {
    if (pressing[group.id]) return
    // Кнопка недоступна если нет ни MQTT ни бэкенда
    if (!mqttOnline && !navigator.onLine) return
    setPressing(p => ({ ...p, [group.id]: true }))
    try {
      const result = await triggerRelay(
        group.id,
        group.device_id,
        group.mqtt_topic,
        group.relay_duration_ms,
      )
      if (result?.state) {
        setStatuses(s => ({ ...s, [group.mqtt_topic]: { ...s[group.mqtt_topic], state: result.state } }))
      }
    } catch (err) {
      console.error('trigger error', err)
    } finally {
      setTimeout(() => setPressing(p => ({ ...p, [group.id]: false })), 300)
    }
  }

  async function handleLogout() { await logout(); onLogout() }

  if (loading) return <div className="app-loading"><div className="spinner" /></div>

  // Если открыты настройки группы — показываем SettingsView
  if (settingsGroup) {
    return (
      <div className="main-screen">
        <header className="main-header">
          <button className="btn btn-outline btn-sm" onClick={() => setSettingsGroup(null)}>
            ← Назад
          </button>
          <h1 className="main-title">{settingsGroup.name}</h1>
          <div style={{ width: 80 }} />
        </header>
        <SettingsView
          group={settingsGroup}
          groups={groups.filter(g => g.role === 'admin')}
          onBack={() => setSettingsGroup(null)}
          currentUser={user}
        />
      </div>
    )
  }

  return (
    <div className="main-screen">
      <header className="main-header">
        <h1 className="main-title">Привратник</h1>
        <button className="btn-icon" onClick={() => setShowProfile(p => !p)} title="Профиль">
          👤
        </button>
      </header>

      {showProfile && (
        <div className="profile-panel">
          <div className="profile-info">
            <div className="profile-login">
              {profile?.login}
              {isAdmin && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text2)' }}>admin</span>}
              <span
                className={`mqtt-dot ${mqttOnline ? 'online' : 'offline'}`}
                title={mqttOnline ? 'MQTT подключён' : 'MQTT недоступен'}
              />
            </div>
            {profile?.display_name && <div className="profile-name">{profile.display_name}</div>}
            <div className="profile-id">
              <span className="profile-id-label">Ваш ID:</span>
              <code className="profile-id-value">{profile?.id}</code>
              <button className="btn-copy" onClick={() => navigator.clipboard?.writeText(profile?.id)} title="Скопировать">📋</button>
            </div>
          </div>
          <button className="btn btn-outline btn-sm" onClick={handleLogout}>Выйти</button>
        </div>
      )}

      <div className="groups-list">
        {groups.length === 0 && (
          <div className="empty-state">
            <p>Нет доступных групп.</p>
            <p className="empty-hint">Обратитесь к администратору.</p>
          </div>
        )}

        <div className="relay-grid">
          {groups.map((group, idx) => {
            const status   = statuses[group.mqtt_topic] || {}
            const online   = status.online || group.device_online
            const state    = status.state
            const isPulse  = group.relay_duration_ms > 0
            const isOn     = state === 'on'
            const busy     = pressing[group.id]
            const canAdmin = group.role === 'admin'
            // Последний нечётный элемент — на всю ширину
            const isLastOdd = groups.length % 2 === 1 && idx === groups.length - 1

            return (
              <div
                key={group.id}
                className={`relay-grid-item${isLastOdd ? ' relay-grid-item-full' : ''}`}
              >
                {canAdmin && (
                  <button
                    className="relay-settings-btn"
                    onClick={() => setSettingsGroup(group)}
                    title="Настройки группы"
                  >⚙️</button>
                )}
                <button
                  className={[
                    'relay-btn relay-btn-large',
                    isPulse ? 'relay-pulse' : (isOn ? 'relay-on' : 'relay-off'),
                    busy ? 'relay-busy' : '',
                    !online ? 'relay-offline' : '',
                    !canPress(group) ? 'relay-unavailable' : '',
                  ].join(' ')}
                  onClick={() => handleTrigger(group)}
                  disabled={busy || !canPress(group)}
                >
                  {busy ? (
                    <span className="relay-btn-spinner" />
                  ) : (
                    <>
                      <span className="relay-btn-name">{group.name}</span>
                      <span className="relay-btn-status">
                        <span className={`device-dot ${online ? 'online' : 'offline'}`} />
                        {isPulse ? 'импульс' : isOn ? 'вкл' : 'выкл'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Форматирование записи журнала ────────────────────────────
function formatLogEntry(l) {
  let p = {}
  try { p = typeof l.payload === 'string' ? JSON.parse(l.payload) : (l.payload || {}) } catch {}
  switch (l.action) {
    case 'relay_trigger': {
      const act = p.action || p.state || '?'
      const label = act === 'pulse' ? '⚡ импульс'
                  : act === 'on'    ? '● включено'
                  : act === 'off'   ? '○ выключено'
                  : act
      return label
    }
    case 'login':               return '🔑 вход'
    case 'logout':              return '🚪 выход'
    case 'add_user_to_group': {
      const parts = ['➕ добавлен']
      if (p.login) parts.push(p.login)
      if (p.description) parts.push(`(${p.description})`)
      else if (p.role) parts.push(`[${p.role}]`)
      return parts.join(' ')
    }
    case 'remove_user_from_group': {
      const parts = ['➖ удалён']
      if (p.login) parts.push(p.login)
      if (p.role && p.role !== 'user') parts.push(`[${p.role}]`)
      return parts.join(' ')
    }
    case 'reset_password': {
      const parts = ['🔒 сброс пароля']
      if (p.login) parts.push(p.login)
      return parts.join(' ')
    }
    case 'reset_sessions': {
      const parts = ['⏏ сброс сессии']
      if (p.login) parts.push(p.login)
      return parts.join(' ')
    }
    case 'assign_group_admin': {
      const parts = ['👤 назначен администратор']
      if (p.admin_login) parts.push(p.admin_login)
      if (p.group_name) parts.push(`→ группа "${p.group_name}"`)
      return parts.join(' ')
    }
    case 'generate_device_token': return '📟 код привязки ESP'
    case 'import_users':        return `📥 импорт пользователей`
    case 'update_group':        return '✏️ изменение группы'
    default: return l.action
  }
}

// ══════════════════════════════════════════════════════════════
// SettingsView — управление группой (только для admin)
// ══════════════════════════════════════════════════════════════
function SettingsView({ group, groups, currentUser }) {
  const [tab, setTab]         = useState('users')
  const [users, setUsers]     = useState([])
  const [device, setDevice]   = useState(null)
  const [logs, setLogs]       = useState([])
  const [showAddUser, setShowAddUser]   = useState(false)
  const [editingDesc, setEditingDesc]   = useState(null)
  const [editDescValue, setEditDescValue] = useState('')
  const [resetPwd, setResetPwd]         = useState({})
  const [addMode, setAddMode] = useState('new')
  const [newUser, setNewUser] = useState({ login: '', password: '', role: 'user', description: '', single_session: true })
  const [existingUser, setExistingUser] = useState({ user_id: '', description: '' })
  const [addError, setAddError] = useState(null)
  const [saving, setSaving]   = useState(false)

  const loadTab = useCallback(async () => {
    if (tab === 'users')  { const u = await getGroupUsers(group.id);  setUsers(u)  }
    if (tab === 'device') { const d = await getGroupDevice(group.id); setDevice(d) }
    if (tab === 'logs')   { const l = await getGroupLogs(group.id);   setLogs(l)   }
  }, [group.id, tab])

  useEffect(() => { loadTab() }, [loadTab])

  async function handleResetPwd(userId) {
    const pwd = (resetPwd[userId] || '').trim()
    if (pwd.length < 6) return alert('Минимум 6 символов')
    try {
      await adminResetUserPassword(userId, pwd, group.id)
      setResetPwd(p => ({ ...p, [userId]: '' }))
      alert('Пароль изменён.')
    } catch (e) { alert(e.message) }
  }

  async function handleAddUser(e) {
    e.preventDefault(); setAddError(null); setSaving(true)
    try {
      if (addMode === 'new') {
        await createUser(group.id, newUser)
        setNewUser({ login: '', password: '', role: 'user', description: '', single_session: true })
      } else {
        await addUserById(group.id, existingUser.user_id.trim(), existingUser.description)
        setExistingUser({ user_id: '', description: '' })
      }
      setShowAddUser(false); loadTab()
    } catch (err) {
      if (err.message === 'login_taken')           setAddError('Логин уже занят.')
      else if (err.message === 'already_in_group') setAddError('Пользователь уже в группе.')
      else if (err.message === 'user_not_found')   setAddError('Пользователь не найден.')
      else if (err.message === 'quota_exceeded')   setAddError(err.body?.message || 'Квота исчерпана.')
      else setAddError('Ошибка. Попробуйте ещё раз.')
    } finally { setSaving(false) }
  }

  return (
    <div className="settings-view">
      <div className="tabs">
        {['users', 'device', 'logs'].map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
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
            <ImportFromGroup
              currentGroupId={group.id}
              groups={groups.filter(g => g.id !== group.id)}
              onImported={loadTab}
            />
          </div>

          {showAddUser && (
            <div className="add-user-panel">
              <div className="mode-toggle">
                <button className={`mode-btn ${addMode === 'new' ? 'active' : ''}`} onClick={() => setAddMode('new')}>Новый</button>
                <button className={`mode-btn ${addMode === 'existing' ? 'active' : ''}`} onClick={() => setAddMode('existing')}>По ID</button>
              </div>
              <form onSubmit={handleAddUser} className="add-user-form" autoComplete="off">
                {addMode === 'new' ? (
                  <>
                    <div className="field-row">
                      <div className="field">
                        <label>Логин</label>
                        <input autoComplete="off" value={newUser.login}
                               onChange={e => setNewUser(u => ({ ...u, login: e.target.value }))} required />
                      </div>
                      <div className="field">
                        <label>Пароль</label>
                        <input type="password" autoComplete="new-password" value={newUser.password}
                               onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
                               required minLength={6} />
                      </div>
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label>Роль</label>
                        <select value={newUser.role} onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))}>
                          <option value="user">Пользователь</option>
                          <option value="admin">Администратор</option>
                        </select>
                      </div>
                      {newUser.role === 'admin' && !currentUser?.single_session && (
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
                    <input type="text" value={existingUser.user_id}
                           onChange={e => setExistingUser(u => ({ ...u, user_id: e.target.value }))}
                           placeholder="00000000-0000-0000-0000-000000000000" required />
                  </div>
                )}
                <div className="field">
                  <label>Описание в группе</label>
                  <input
                    value={addMode === 'new' ? newUser.description : existingUser.description}
                    onChange={e => addMode === 'new'
                      ? setNewUser(u => ({ ...u, description: e.target.value }))
                      : setExistingUser(u => ({ ...u, description: e.target.value }))}
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

          <div className="users-list">
            {users.length === 0 && <div className="empty-state">Нет пользователей</div>}
            {users.map(u => (
              <div key={u.id} className="user-card">
                <div className="user-card-main">
                  <div className="user-info">
                    <span className="user-login">
                      {u.role === 'user' ? `${u.login}@${u.mqtt_topic}` : u.login}
                    </span>
                    {u.display_name && <span className="user-display-name-inline">{u.display_name}</span>}
                    <span className={`user-role role-${u.role}`}>{u.role}</span>
                    {u.has_session && <span className="session-dot" title="Есть активная сессия">●</span>}
                    {!u.is_active && <span className="badge-inactive">неактивен</span>}
                  </div>

                  <div className="user-description">
                    {editingDesc === u.id ? (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input type="text" value={editDescValue}
                               onChange={e => setEditDescValue(e.target.value)}
                               className="input-inline" style={{ flex: 1, minWidth: 150 }} autoFocus />
                        <button className="btn btn-primary btn-xs" onClick={async () => {
                          try { await updateUserDescription(group.id, u.id, editDescValue); setEditingDesc(null); loadTab() }
                          catch { alert('Ошибка при сохранении') }
                        }}>✓</button>
                        <button className="btn btn-outline btn-xs" onClick={() => setEditingDesc(null)}>✕</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{u.description || <span style={{ color: 'var(--text2)' }}>—</span>}</span>
                        <button className="btn-icon" style={{ fontSize: 14 }}
                                onClick={() => { setEditingDesc(u.id); setEditDescValue(u.description || '') }}
                                title="Редактировать описание">✎</button>
                      </div>
                    )}
                  </div>

                  <div className="user-uid">
                    <span className="user-uid-label">ID:</span>
                    <code className="user-uid-value">{u.id}</code>
                    <button className="btn-copy" onClick={() => navigator.clipboard?.writeText(u.id)} title="Скопировать ID">📋</button>
                  </div>
                </div>

                <div className="user-card-actions">
                  {u.has_session && (
                    <button className="btn btn-outline btn-xs"
                            onClick={async () => { await resetUserSessions(u.id, group.id); loadTab() }}>
                      ⏏ Сессия
                    </button>
                  )}
                  <input className="input-inline" placeholder="Новый пароль" type="password"
                         value={resetPwd[u.id] || ''}
                         onChange={e => setResetPwd(p => ({ ...p, [u.id]: e.target.value }))} />
                  <button className="btn btn-warning btn-xs" onClick={() => handleResetPwd(u.id)}>
                    Сбросить пароль
                  </button>
                  <button className="btn btn-danger btn-xs"
                          onClick={async () => {
                            if (!confirm(`Удалить ${u.role === 'user' ? u.login+'@'+u.mqtt_topic : u.login} из группы?`)) return
                            await removeUserFromGroup(group.id, u.id); loadTab()
                          }}>✕</button>
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
                <div><b>Последний раз:</b> {device.last_seen ? new Date(device.last_seen).toLocaleString('ru') : '—'}</div>
              </div>
            </div>
          ) : (
            <div className="empty-state">Устройство не привязано</div>
          )}
          <div className="device-token-section">
            <div className="section-title">Код привязки ESP</div>
            {device?.pending_code ? (
              <div className="token-display">
                <div className="token-code">{device.pending_code}</div>
                <div className="token-hint">
                  Введите в CaptivePortal устройства.<br />
                  Действует до {new Date(device.code_expires_at).toLocaleString('ru')}
                </div>
              </div>
            ) : (
              <button className="btn btn-primary" onClick={async () => {
                const result = await generateDeviceToken(group.id)
                setDevice(d => ({ ...d, pending_code: result.code, code_expires_at: result.expires_at }))
              }}>Сгенерировать код привязки</button>
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
                <span className="log-ts">
                  {new Date(l.ts).toLocaleString('ru', {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                  })}
                </span>
                <span className="log-actor">
                  {l.actor_login
                    ? (l.actor_role === 'user' ? `${l.actor_login}@${group.mqtt_topic}` : l.actor_login)
                    : '—'}
                </span>
                <span className="log-description">{formatLogEntry(l)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Импорт пользователей из группы ───────────────────────────
function ImportFromGroup({ currentGroupId, groups, onImported }) {
  const [sourceId, setSourceId] = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleImport() {
    if (!sourceId) return
    const group = groups.find(g => g.id === sourceId)
    if (!confirm(`Добавить всех пользователей из "${group?.name}"?`)) return
    setLoading(true)
    try {
      const result = await importUsersFromGroup(currentGroupId, sourceId)
      onImported()
      alert(`Добавлено: ${result.added} пользователей`)
      setSourceId('')
    } catch (e) {
      alert('Ошибка: ' + e.message)
    } finally { setLoading(false) }
  }

  if (groups.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <select value={sourceId} onChange={e => setSourceId(e.target.value)}
              style={{ background: 'var(--bg)', border: '1px solid var(--border)',
                       color: 'var(--text)', borderRadius: 6, padding: '7px 10px', fontSize: 13 }}>
        <option value="">Добавить всех из...</option>
        {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <button className="btn btn-outline btn-sm" onClick={handleImport} disabled={!sourceId || loading}>
        {loading ? '...' : '↓ Импорт'}
      </button>
    </div>
  )
}
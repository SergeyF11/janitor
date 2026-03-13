import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getMyGroups, getMyProfile, triggerRelay, logout, createWsConnection,
  getGroupUsers, getGroupDevice, generateDeviceToken, createUser, addUserById,
  importUsersFromGroup, removeUserFromGroup, resetUserSessions,
  updateSingleSession, adminResetUserPassword, adminTriggerRelay,
  getGroupLogs, updateUserDescription, patchAdminRelay
} from '../api'
import ExpiryWarning from '../~components/ExpiryWarning'

export default function Main({ user, onLogout }) {
  const [groups, setGroups]           = useState([])
  const [profile, setProfile]         = useState(null)
  const [loading, setLoading]         = useState(true)
  const [pressing, setPressing]       = useState({})
  const [relayStates, setRelayStates] = useState({})
  const [devOnline, setDevOnline]     = useState({})
  const [showProfile, setShowProfile] = useState(false)
  const [settingsGroup, setSettingsGroup] = useState(null)  // группа для панели настроек
  const wsRef = useRef(null)

  const loadData = useCallback(async () => {
    try {
      const [g, p] = await Promise.all([getMyGroups(), getMyProfile()])
      setGroups(g)
      setProfile(p)
      const states = {}, online = {}
      g.forEach(gr => {
        if (gr.device_id) online[gr.device_id] = gr.device_online
        ;(gr.relays || []).forEach(r => { states[r.id] = r.last_state || 'off' })
      })
      setRelayStates(states)
      setDevOnline(online)
    } catch (err) {
      console.error('load error', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const ws = createWsConnection((msg) => {
      if (msg.type === 'relay_status') {
        setRelayStates(s => ({ ...s, [msg.relay_id]: msg.state }))
      }
      if (msg.type === 'device_status') {
        setDevOnline(s => ({ ...s, [msg.device_id]: msg.online }))
      }
    })
    wsRef.current = ws
    return () => ws.close()
  }, [loadData])

  async function handleTrigger(relay) {
    if (pressing[relay.id]) return
    setPressing(p => ({ ...p, [relay.id]: true }))
    try {
      const result = await triggerRelay(relay.id)
      setRelayStates(s => ({ ...s, [relay.id]: result.state }))
    } catch (err) {
      console.error('trigger error', err)
    } finally {
      setTimeout(() => setPressing(p => ({ ...p, [relay.id]: false })), 300)
    }
  }

  async function handleLogout() { await logout(); onLogout() }

  if (loading) return <div className="app-loading"><div className="spinner" /></div>

  // Если открыта панель настроек — показываем её поверх основного экрана
  if (settingsGroup) {
    return (
      <AdminSettings
        group={settingsGroup}
        groups={groups}
        user={user}
        onBack={() => setSettingsGroup(null)}
        onLogout={handleLogout}
      />
    )
  }

  return (
    <div className="main-screen">
      <header className="main-header">
        <h1 className="main-title">Привратник</h1>
        <button className="btn-icon" onClick={() => setShowProfile(p => !p)} title="Профиль">👤</button>
      </header>

      {showProfile && (
        <div className="profile-panel">
          <div className="profile-info">
            <div className="profile-login">{profile?.login}</div>
            {profile?.display_name && <div className="profile-name">{profile.display_name}</div>}
            <div className="profile-id">
              <span className="profile-id-label">ID:</span>
              <code className="profile-id-value">{profile?.id}</code>
              <button className="btn-copy" onClick={() => navigator.clipboard?.writeText(profile?.id)} title="Скопировать">📋</button>
            </div>
          </div>
          <button className="btn btn-outline btn-sm" onClick={handleLogout}>Выйти</button>
        </div>
      )}

      <ExpiryWarning groups={groups} />

      <div className="groups-list">
        {groups.length === 0 && (
          <div className="empty-state">
            <p>Нет доступных групп.</p>
            <p className="empty-hint">Обратитесь к администратору.</p>
          </div>
        )}

        {groups.map(group => {
          const online  = devOnline[group.device_id] ?? group.device_online ?? false
          const relays  = group.relays || []
          const isAdmin = group.role === 'admin'

          return (
            <div key={group.id} className="group-card">
              <div className="group-header">
                <div className="group-name">{group.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className={`device-dot ${online ? 'online' : 'offline'}`}
                       title={online ? 'Устройство онлайн' : 'Устройство оффлайн'} />
                  {isAdmin && (
                    <button
                      className="btn-icon"
                      title="Настройки группы"
                      onClick={() => setSettingsGroup(group)}
                      style={{ fontSize: 16 }}
                    >⚙️</button>
                  )}
                </div>
              </div>

              {relays.length === 0 && (
                <div className="group-offline-hint">Нет реле</div>
              )}

              <div className="buttons-grid">
                {relays.map(relay => {
                  const state   = relayStates[relay.id] || relay.last_state || 'off'
                  const isPulse = relay.duration_ms > 0
                  const isOn    = state === 'on'
                  const busy    = pressing[relay.id]
                  const blocked = group.status === 'blocked'
                  return (
                    <button
                      key={relay.id}
                      className={[
                        'relay-btn',
                        isPulse ? 'relay-pulse' : (isOn ? 'relay-on' : 'relay-off'),
                        busy    ? 'relay-busy'    : '',
                        !online ? 'relay-offline' : '',
                      ].join(' ')}
                      onClick={() => handleTrigger(relay)}
                      disabled={busy || !online || blocked}
                    >
                      {busy ? (
                        <span className="relay-btn-spinner" />
                      ) : isPulse ? (
                        `▶ ${relay.name}`
                      ) : isOn ? (
                        `● ${relay.name} — Вкл`
                      ) : (
                        `○ ${relay.name} — Выкл`
                      )}
                    </button>
                  )
                })}
              </div>

              {group.status === 'blocked' && <div className="group-offline-hint">Группа заблокирована суперадмином</div>}
              {!online && <div className="group-offline-hint">Устройство недоступно</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Панель настроек группы (только для admin) ─────────────────
function AdminSettings({ group, groups, user, onBack, onLogout }) {
  const [tab, setTab] = useState('users')

  return (
    <div className="admin-screen">
      <header className="admin-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-outline btn-sm" onClick={onBack}>← Назад</button>
          <h1 className="admin-title">{group.name}</h1>
        </div>
        <div className="admin-header-right">
          <span className="admin-login">{user.login}</span>
          <button className="btn btn-outline btn-sm" onClick={onLogout}>Выйти</button>
        </div>
      </header>

      <div className="admin-layout">
        <main className="admin-content" style={{ width: '100%' }}>
          <div className="tabs">
            {['users', 'device', 'relays', 'logs'].map(t => (
              <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                {{ users: 'Пользователи', device: 'Устройство', relays: 'Реле', logs: 'Журнал' }[t]}
              </button>
            ))}
          </div>

          {tab === 'users'  && <UsersTab  group={group} groups={groups} user={user} />}
          {tab === 'device' && <DeviceTab group={group} />}
          {tab === 'relays' && <RelaysTab group={group} />}
          {tab === 'logs'   && <LogsTab   group={group} />}
        </main>
      </div>
    </div>
  )
}

// ── Вкладка: Пользователи ─────────────────────────────────────
function UsersTab({ group, groups, user: currentUser }) {
  const [users, setUsers]             = useState([])
  const [showAdd, setShowAdd]         = useState(false)
  const [addMode, setAddMode]         = useState('new')
  const [newUser, setNewUser]         = useState({ login: '', password: '', role: 'user', description: '', single_session: true })
  const [existingUser, setExistingUser] = useState({ user_id: '', description: '' })
  const [addError, setAddError]       = useState(null)
  const [saving, setSaving]           = useState(false)
  const [editingDesc, setEditingDesc] = useState(null)
  const [editDescValue, setEditDescValue] = useState('')
  const [resetPwd, setResetPwd]       = useState({})

  const load = useCallback(async () => {
    try { setUsers(await getGroupUsers(group.id)) } catch {}
  }, [group.id])

  useEffect(() => { load() }, [load])

  async function handleAdd(e) {
    e.preventDefault(); setAddError(null); setSaving(true)
    try {
      if (addMode === 'new') {
        await createUser(group.id, newUser)
        setNewUser({ login: '', password: '', role: 'user', description: '', single_session: true })
      } else {
        await addUserById(group.id, existingUser.user_id.trim(), existingUser.description)
        setExistingUser({ user_id: '', description: '' })
      }
      setShowAdd(false); load()
    } catch (err) {
      if (err.message === 'login_taken')           setAddError('Логин уже занят.')
      else if (err.message === 'already_in_group') setAddError('Пользователь уже в группе.')
      else if (err.message === 'user_not_found')   setAddError('Пользователь не найден.')
      else if (err.message === 'quota_exceeded')   setAddError(err.body?.message || 'Квота исчерпана.')
      else setAddError('Ошибка. Попробуйте ещё раз.')
    } finally { setSaving(false) }
  }

  async function handleResetPwd(userId) {
    const pwd = (resetPwd[userId] || '').trim()
    if (pwd.length < 6) return alert('Минимум 6 символов')
    try { await adminResetUserPassword(userId, pwd); setResetPwd(p => ({ ...p, [userId]: '' })); alert('Пароль изменён.') }
    catch (e) { alert(e.message) }
  }

  return (
    <div className="tab-content">
      <div className="tab-toolbar">
        <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(v => !v)}>
          {showAdd ? 'Отмена' : '+ Добавить'}
        </button>
        <ImportFromGroup
          currentGroupId={group.id}
          groups={groups.filter(g => g.id !== group.id)}
          onImported={load}
        />
      </div>

      {showAdd && (
        <div className="add-user-panel">
          <div className="mode-toggle">
            <button className={`mode-btn ${addMode === 'new' ? 'active' : ''}`} onClick={() => setAddMode('new')}>Новый</button>
            <button className={`mode-btn ${addMode === 'existing' ? 'active' : ''}`} onClick={() => setAddMode('existing')}>По ID</button>
          </div>
          <form onSubmit={handleAdd} className="add-user-form" autoComplete="off">
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
                    {u.role === 'user'
                      ? <>{u.login}<span style={{color:'var(--text2)'}}>@{group.mqtt_topic}</span></>
                      : u.login}
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
                      try { await updateUserDescription(group.id, u.id, editDescValue); setEditingDesc(null); load() }
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
                <span className="user-uid-label">Логин:</span>
                <code className="user-uid-value">
                  {u.role === 'user' ? u.login + '@' + group.mqtt_topic : u.login}
                </code>
                <button className="btn-copy"
                  onClick={() => navigator.clipboard?.writeText(
                    u.role === 'user' ? u.login + '@' + group.mqtt_topic : u.login
                  )}
                  title="Скопировать логин">📋</button>
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
                        onClick={async () => { await resetUserSessions(u.id); load() }}
                        title="Сбросить сессию">⏏ Сессия</button>
              )}
              {u.id !== currentUser.id && (
                <button className="btn btn-outline btn-xs"
                        onClick={async () => { if (confirm('Удалить из группы?')) { await removeUserFromGroup(group.id, u.id); load() } }}>
                  🗑 Удалить
                </button>
              )}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4 }}>
                <input type="password" placeholder="Новый пароль"
                       value={resetPwd[u.id] || ''}
                       onChange={e => setResetPwd(p => ({ ...p, [u.id]: e.target.value }))}
                       style={{ width: 130, fontSize: 12, padding: '3px 6px',
                                background: 'var(--bg)', border: '1px solid var(--border)',
                                color: 'var(--text)', borderRadius: 4 }} />
                <button className="btn btn-outline btn-xs"
                        onClick={() => handleResetPwd(u.id)}>🔑</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <label style={{ fontSize: 12, color: 'var(--text2)' }}>Одна сессия</label>
                <input type="checkbox" checked={u.single_session}
                       onChange={async e => { await updateSingleSession(u.id, e.target.checked); load() }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Вкладка: Устройство ───────────────────────────────────────
function DeviceTab({ group }) {
  const [device, setDevice] = useState(null)

  const load = useCallback(async () => {
    try { setDevice(await getGroupDevice(group.id)) } catch {}
  }, [group.id])

  useEffect(() => { load() }, [load])

  return (
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
  )
}

// ── Вкладка: Реле ─────────────────────────────────────────────
function RelaysTab({ group }) {
  const [device, setDevice]   = useState(null)
  const [pressing, setPressing] = useState({})
  const [lastState, setLastState] = useState({})
  const [editing, setEditing] = useState(null)
  const [editVal, setEditVal] = useState({})

  const load = useCallback(async () => {
    try {
      const d = await getGroupDevice(group.id)
      setDevice(d)
      if (d?.relays) {
        const init = {}
        d.relays.forEach(r => { init[r.id] = r.last_state || 'off' })
        setLastState(init)
      }
    } catch {}
  }, [group.id])

  useEffect(() => { load() }, [load])

  async function handleTrigger(relay) {
    setPressing(p => ({ ...p, [relay.id]: true }))
    try {
      const res = await adminTriggerRelay(relay.id)
      setLastState(s => ({ ...s, [relay.id]: res.state }))
    } catch (e) { alert(e.message) }
    finally { setPressing(p => ({ ...p, [relay.id]: false })) }
  }

  const relays = device?.relays || []
  const isOnline = device?.is_online

  return (
    <div className="tab-content">
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`device-dot ${device?.device_id && isOnline ? 'online' : 'offline'}`} />
        <span style={{ fontSize: 13, color: 'var(--text2)' }}>
          {device?.device_id
            ? `${isOnline ? 'Онлайн' : 'Оффлайн'} · ${device.device_id}${device.fw_version ? ` · v${device.fw_version}` : ''}`
            : 'Устройство не привязано'}
        </span>
      </div>

      {relays.length === 0 && device?.device_id && <div style={{ color: 'var(--text2)', fontSize: 13 }}>Нет реле</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {relays.map(relay => {
          const state   = lastState[relay.id] || 'off'
          const isPulse = relay.duration_ms > 0
          const busy    = pressing[relay.id]
          const isEditing = editing === relay.id

          return (
            <div key={relay.id} className="relay-settings-row">
              {isEditing ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <div className="field" style={{ flex: 1, minWidth: 120 }}>
                    <label style={{ fontSize: 12 }}>Название</label>
                    <input value={editVal.name || ''} onChange={e => setEditVal(v => ({ ...v, name: e.target.value }))}
                           className="input-inline" />
                  </div>
                  <div className="field" style={{ width: 100 }}>
                    <label style={{ fontSize: 12 }}>Длит. (мс)</label>
                    <input type="number" value={editVal.duration_ms ?? ''} min={0}
                           onChange={e => setEditVal(v => ({ ...v, duration_ms: parseInt(e.target.value) || 0 }))}
                           className="input-inline" />
                  </div>
                  <button className="btn btn-primary btn-xs" onClick={async () => {
                    try {
                        await patchAdminRelay(relay.id, editVal)
                      setEditing(null); load()
                    } catch (e) { alert(e.message) }
                  }}>✓</button>
                  <button className="btn btn-outline btn-xs" onClick={() => setEditing(null)}>✕</button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontWeight: 500 }}>{relay.name}</span>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                    {relay.duration_ms > 0 ? `импульс ${relay.duration_ms}мс` : 'переключатель'}
                  </span>
                  <button className="btn-icon" style={{ fontSize: 14 }} onClick={() => {
                    setEditing(relay.id); setEditVal({ name: relay.name, duration_ms: relay.duration_ms })
                  }}>✎</button>
                </div>
              )}
              <button
                className={['relay-btn', isPulse ? 'relay-pulse' : (state === 'on' ? 'relay-on' : 'relay-off'),
                            busy ? 'relay-busy' : '', !isOnline ? 'relay-offline' : ''].join(' ')}
                onClick={() => handleTrigger(relay)}
                disabled={busy || !device?.device_id}
              >
                {busy ? <span className="relay-btn-spinner" />
                  : isPulse ? `▶ ${relay.name}`
                  : state === 'on' ? `● ${relay.name} — Вкл` : `○ ${relay.name} — Выкл`}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Вкладка: Журнал ───────────────────────────────────────────
function LogsTab({ group }) {
  const [logs, setLogs] = useState([])

  useEffect(() => {
    getGroupLogs(group.id).then(setLogs).catch(() => {})
  }, [group.id])

  return (
    <div className="tab-content">
      <div className="logs-list">
        {logs.length === 0 && <div className="empty-state">Нет событий</div>}
        {logs.map(l => {
          const payload = l.payload
            ? (typeof l.payload === 'string'
                ? (() => { try { return JSON.parse(l.payload) } catch { return l.payload } })()
                : l.payload)
            : null
          const payloadStr = payload
            ? (typeof payload === 'object'
                ? Object.entries(payload).map(([k,v]) => `${k}: ${v}`).join(' · ')
                : String(payload))
            : null
          return (
            <div key={l.id} className="log-entry">
              <span className="log-ts">{new Date(l.ts).toLocaleString('ru')}</span>
              <span className="log-actor">{l.actor_login || '—'}</span>
              <span className={`log-action action-${l.action}`}>{l.action}</span>
              {l.relay_name && <span className="log-relay">{l.relay_name}</span>}
              {payloadStr && <span className="log-payload">{payloadStr}</span>}
            </div>
          )
        })}
      </div>
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
      onImported(); alert(`Добавлено: ${result.added} пользователей`); setSourceId('')
    } catch (e) { alert('Ошибка: ' + e.message) }
    finally { setLoading(false) }
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
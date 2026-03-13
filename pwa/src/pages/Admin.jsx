import { useState, useEffect, useCallback } from 'react'
import {
  getAdminGroups, getGroupUsers, getAdminUsers, createUser, addUserById, importUsersFromGroup,
  removeUserFromGroup, resetUserSessions, updateSingleSession, adminResetUserPassword,
  getGroupDevice, generateDeviceToken, adminTriggerRelay,
  getGroupLogs, logout, updateUserDescription
} from '../api'

export default function Admin({ user, onLogout }) {
  const [groups, setGroups]     = useState([])
  const [selected, setSelected] = useState(null)
  const [view, setView]         = useState('relay')   // relay | settings
  const [loading, setLoading]   = useState(true)

  const loadGroups = useCallback(async () => {
    try {
      const g = await getAdminGroups()
      setGroups(g)
      if (g.length > 0 && !selected) setSelected(g[0])
    } catch {}
    setLoading(false)
  }, [selected])

  useEffect(() => { loadGroups() }, [])

  async function handleLogout() { await logout(); onLogout() }

  if (loading) return <div className="app-loading"><div className="spinner" /></div>

  return (
    <div className="admin-screen">
      <header className="admin-header">
        <h1 className="admin-title">Управление</h1>
        <div className="admin-header-right">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <span className="admin-login">{user.login}</span>
            <span style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'monospace' }} title="Ваш ID">
              {user.id}
              <button className="btn-copy" onClick={() => navigator.clipboard?.writeText(user.id)} title="Скопировать ID">📋</button>
            </span>
          </div>
          <button className="btn btn-outline btn-sm" onClick={handleLogout}>Выйти</button>
        </div>
      </header>

      <div className="admin-layout">
        <aside className="groups-sidebar">
          <div className="sidebar-title">Группы</div>
          {groups.map(g => (
            <button key={g.id}
              className={`sidebar-item ${selected?.id === g.id ? 'active' : ''}`}
              onClick={() => { setSelected(g); setView('relay') }}>
              <span className="sidebar-item-name">{g.name}</span>
              <span className="sidebar-item-count">{g.user_count}</span>
            </button>
          ))}
        </aside>

        <main className="admin-content">
          {!selected ? (
            <div className="empty-state">Выберите группу</div>
          ) : (
            <>
              <div className="content-header">
                <h2 className="content-title">{selected.name}</h2>
                <button
                  className={`btn btn-sm ${view === 'settings' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setView(v => v === 'settings' ? 'relay' : 'settings')}
                >
                  ⚙️ Настройки
                </button>
              </div>

              {view === 'relay'
                ? <RelayView group={selected} />
                : <SettingsView group={selected} groups={groups} onBack={() => setView('relay')} />
              }
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// ── Главный экран: кнопки управления реле ────────────────────
// function RelayView({ group }) {
//   const [device, setDevice]       = useState(null)
//   const [pressing, setPressing]   = useState({})
//   const [lastState, setLastState] = useState({})
//   const [error, setError]         = useState(null)

//   useEffect(() => {
//     getGroupDevice(group.id).then(setDevice).catch(() => {})
//   }, [group.id])

//   async function handleTrigger(relayIndex = 0) {
//     setError(null)
//     setPressing(p => ({ ...p, [relayIndex]: true }))
//     try {
//       const res = await adminTriggerRelay(group.id, relayIndex)
//       setLastState(s => ({ ...s, [relayIndex]: res.state }))
//     } catch (e) {
//       setError(e.message)
//     } finally {
//       setPressing(p => ({ ...p, [relayIndex]: false }))
//     }
//   }

//   const isPulse   = group.relay_duration_ms > 0
//   const hasDevice = !!device?.device_id
//   const isOnline  = device?.is_online

//   const relays = device?.relay_index != null
//     ? [{ index: device.relay_index, name: 'Реле ' + (device.relay_index + 1) }]
//     : [{ index: 0, name: 'Реле 1' }]

//   return (
//     <div className="relay-view">
//       {/* Статус устройства */}
//       <div className="device-status-bar">
//         <span className={`device-dot-lg ${hasDevice && isOnline ? 'online' : 'offline'}`} />
//         <span style={{ fontSize: 13, color: 'var(--text2)' }}>
//           {hasDevice
//             ? `${isOnline ? 'Онлайн' : 'Оффлайн'} · ${device.device_id}${device.fw_version ? ` · v${device.fw_version}` : ''}`
//             : 'Устройство не привязано'}
//         </span>
//       </div>

//       {error && <div style={{ color: 'var(--danger)', fontSize: 13, margin: '8px 0' }}>{error}</div>}

//       {/* Кнопки реле */}
//       <div className="relay-buttons">
//         {relays.map(relay => {
//           const st   = lastState[relay.index]
//           const busy = pressing[relay.index]
//           return (
//             <button
//               key={relay.index}
//               className={`relay-btn${st === 'on' ? ' relay-btn-on' : ''}${busy ? ' relay-btn-busy' : ''}`}
//               onClick={() => handleTrigger(relay.index)}
//               disabled={busy || !hasDevice}
//             >
//               {busy
//                 ? <span className="relay-btn-spinner" />
//                 : <>
//                     <span className="relay-btn-icon">
//                       {isPulse ? '⚡' : st === 'on' ? '🔴' : '🟢'}
//                     </span>
//                     <span className="relay-btn-label">{relay.name}</span>
//                     <span className="relay-btn-hint">
//                       {isPulse
//                         ? `импульс ${group.relay_duration_ms / 1000} с`
//                         : st === 'on' ? 'включено' : st === 'off' ? 'выключено' : '—'}
//                     </span>
//                   </>
//               }
//             </button>
//           )
//         })}
//       </div>
//     </div>
//   )
// }

function RelayView({ group }) {
  const [device, setDevice] = useState(null);
  const [pressing, setPressing] = useState({});   // relayId → bool
  const [lastState, setLastState] = useState({});  // relayId → state
  const [error, setError] = useState(null);

  useEffect(() => {
    getGroupDevice(group.id).then(d => {
      setDevice(d);
      // Инициализировать состояния из device.relays
      if (d?.relays) {
        const init = {};
        d.relays.forEach(r => { init[r.id] = r.last_state || 'off'; });
        setLastState(init);
      }
    }).catch(() => {});
  }, [group.id]);

  async function handleTrigger(relay) {
    setError(null);
    setPressing(p => ({ ...p, [relay.id]: true }));
    try {
      const res = await adminTriggerRelay(relay.id);
      setLastState(s => ({ ...s, [relay.id]: res.state }));
    } catch (e) {
      setError(e.message);
    } finally {
      setPressing(p => ({ ...p, [relay.id]: false }));
    }
  }

  const hasDevice = !!device?.device_id;
  const isOnline  = device?.is_online;
  const relays    = device?.relays || [];

  return (
    <div className="relay-view">
      <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span className={`device-dot ${hasDevice && isOnline ? 'online' : 'offline'}`} />
        <span style={{ fontSize: 13, color: 'var(--text2)' }}>
          {hasDevice
            ? `${isOnline ? 'Онлайн' : 'Оффлайн'} · ${device.device_id}${device.fw_version ? ` · v${device.fw_version}` : ''}`
            : 'Устройство не привязано'}
        </span>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 13, margin: '8px 0' }}>{error}</div>}

      {relays.length === 0 && hasDevice && (
        <div style={{ color: 'var(--text2)', fontSize: 13 }}>Реле не найдены</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {relays.map(relay => {
          const state   = lastState[relay.id] || 'off';
          const isPulse = relay.duration_ms > 0;
          const busy    = pressing[relay.id];

          return (
            <div key={relay.id}>
              {relays.length > 1 && (
                <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{relay.name}</div>
              )}
              <button
                className={[
                  'relay-btn',
                  isPulse ? 'relay-pulse' : (state === 'on' ? 'relay-on' : 'relay-off'),
                  busy ? 'relay-busy' : '',
                  !isOnline ? 'relay-offline' : '',
                ].join(' ')}
                onClick={() => handleTrigger(relay)}
                disabled={busy || !hasDevice}
              >
                {busy ? (
                  <span className="relay-btn-spinner" />
                ) : (
                  isPulse ? `▶ ${relay.name}` : (state === 'on' ? `● ${relay.name} — Вкл` : `○ ${relay.name} — Выкл`)
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Настройки: пользователи / устройство / журнал ─────────────
function SettingsView({ group, groups, onBack }) {
  const [tab, setTab]         = useState('users')
  const [users, setUsers]     = useState([])
  const [device, setDevice]   = useState(null)
  const [logs, setLogs]       = useState([])
  const [showAddUser, setShowAddUser] = useState(false)
  const [editingDesc, setEditingDesc] = useState(null)   // userId
  const [editDescValue, setEditDescValue] = useState('')
  const [resetPwd, setResetPwd]       = useState({})  // userId → string
  const [addMode, setAddMode] = useState('new')
  const [newUser, setNewUser] = useState({ login: '', password: '', role: 'user', description: '', single_session: true })
  const [existingUser, setExistingUser] = useState({ user_id: '', description: '' })
  const [addError, setAddError] = useState(null)
  const [saving, setSaving]   = useState(false)

  async function handleResetPwd(userId) {
    const pwd = (resetPwd[userId] || '').trim()
    if (pwd.length < 6) return alert('Минимум 6 символов')
    try {
      await adminResetUserPassword(userId, pwd)
      setResetPwd(p => ({ ...p, [userId]: '' }))
      alert('Пароль изменён.')
    } catch (e) { alert(e.message) }
  }

  const loadTab = useCallback(async () => {
    if (tab === 'users')  { const u = await getGroupUsers(group.id);  setUsers(u)  }
    if (tab === 'device') { const d = await getGroupDevice(group.id); setDevice(d) }
    if (tab === 'logs')   { const l = await getGroupLogs(group.id);   setLogs(l)   }
  }, [group.id, tab])

  useEffect(() => { loadTab() }, [loadTab])

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
                      type="text"
                      value={existingUser.user_id}
                      onChange={e => setExistingUser(u => ({ ...u, user_id: e.target.value }))}
                      placeholder="00000000-0000-0000-0000-000000000000"
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
                  <span className="user-login">{u.login}</span>
                  {u.display_name && <span className="user-display-name-inline">{u.display_name}</span>}
                  <span className={`user-role role-${u.role}`}>{u.role}</span>
                  {u.has_session && <span className="session-dot" title="Есть активная сессия">●</span>}
                  {!u.is_active && <span className="badge-inactive">неактивен</span>}
                </div>

                {/* Блок описания с редактированием */}
                <div className="user-description">
                  {editingDesc === u.id ? (
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        value={editDescValue}
                        onChange={e => setEditDescValue(e.target.value)}
                        className="input-inline"
                        style={{ flex: 1, minWidth: '150px' }}
                        autoFocus
                      />
                      <button
                        className="btn btn-primary btn-xs"
                        onClick={async () => {
                          try {
                            await updateUserDescription(group.id, u.id, editDescValue)
                            setEditingDesc(null)
                            loadTab()
                          } catch (err) {
                            alert('Ошибка при сохранении описания')
                          }
                        }}
                      >
                        ✓
                      </button>
                      <button
                        className="btn btn-outline btn-xs"
                        onClick={() => setEditingDesc(null)}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>{u.description || <span style={{ color: 'var(--text2)' }}>—</span>}</span>
                      <button
                        className="btn-icon"
                        style={{ fontSize: '14px' }}
                        onClick={() => {
                          setEditingDesc(u.id)
                          setEditDescValue(u.description || '')
                        }}
                        title="Редактировать описание"
                      >
                        ✎
                      </button>
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
                          onClick={async () => { await resetUserSessions(u.id); loadTab() }}
                          title="Сбросить сессию">⏏ Сессия</button>
                )}
                {/* остальные кнопки */}
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
                <span className="log-ts">{new Date(l.ts).toLocaleString('ru')}</span>
                <span className="log-actor">{l.actor_login || '—'}</span>
                <span className={`log-action action-${l.action}`}>{l.action}</span>
                {l.payload && <span className="log-payload">{JSON.stringify(l.payload).substring(0, 60)}</span>}
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
import { useState, useEffect, useCallback } from 'react'
import {
  saGetStats, saGetAdmins, saCreateAdmin, saUpdateAdmin, saDeleteAdmin,
  saResetAdminSessions, saResetAdminPassword,
  saGetGroups, saCreateGroup, saUpdateGroup, saDeleteGroup,
  saAssignGroupAdmin, saRemoveGroupAdmin,
  saGetUsers, saUpdateUser, saResetUserPassword, saResetUserSessions,
  saGetDevices, saDeleteDevice,
  saGetLogs, saQuery, logout
} from '../api'

const TABS = ['stats', 'admins', 'groups', 'users', 'devices', 'logs', 'sql']
const TAB_LABELS = {
  stats: 'Статистика', admins: 'Администраторы', groups: 'Группы',
  users: 'Пользователи', devices: 'Устройства', logs: 'Журнал', sql: 'SQL'
}

export default function SuperAdmin({ user, onLogout }) {
  const [tab, setTab]       = useState('stats')
  const [data, setData]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const loaders = {
        stats:   saGetStats,
        admins:  saGetAdmins,
        groups:  saGetGroups,
        users:   () => saGetUsers({ limit: 100 }),
        devices: saGetDevices,
        logs:    () => saGetLogs({ limit: 100 }),
        sql:     () => null,
      }
      const result = await loaders[tab]()
      setData(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { load() }, [load])

  async function handleLogout() {
    await logout()
    onLogout()
  }

  return (
    <div className="sa-screen">
      <header className="sa-header">
        <h1 className="sa-title">⚙️ Суперадмин</h1>
        <div className="sa-header-right">
          <span className="sa-login">{user?.login}</span>
          <button className="btn btn-outline btn-sm" onClick={handleLogout}>Выйти</button>
        </div>
      </header>

      <div className="sa-layout">
        <nav className="sa-nav">
          {TABS.map(t => (
            <button key={t} className={`sa-nav-item ${tab === t ? 'active' : ''}`}
                    onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>

        <main className="sa-content">
          {loading && <div className="sa-loading"><div className="spinner" /></div>}
          {error   && <div className="sa-error">{error}</div>}
          {!loading && !error && (
            <>
              {tab === 'stats'   && <StatsTab   data={data} />}
              {tab === 'admins'  && <AdminsTab  data={data} reload={load} />}
              {tab === 'groups'  && <GroupsTab  data={data} reload={load} />}
              {tab === 'users'   && <UsersTab   data={data} reload={load} />}
              {tab === 'devices' && <DevicesTab data={data} reload={load} />}
              {tab === 'logs'    && <LogsTab    data={data} reload={load} />}
              {tab === 'sql'     && <SqlTab />}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// ── Статистика ────────────────────────────────────────────────
function StatsTab({ data }) {
  if (!data) return null
  const items = [
    { label: 'Пользователей',  value: data.total_users },
    { label: 'Администраторов', value: data.total_admins },
    { label: 'Групп',          value: data.total_groups },
    { label: 'Устройств',      value: data.total_devices },
    { label: 'Онлайн',         value: data.online_devices },
    { label: 'Активных сессий', value: data.active_sessions },
    { label: 'Событий за 24ч', value: data.events_24h },
    { label: 'Входов за 24ч',  value: data.logins_24h },
  ]
  return (
    <div className="stats-grid">
      {items.map(({ label, value }) => (
        <div key={label} className="stat-card">
          <div className="stat-value">{value ?? '—'}</div>
          <div className="stat-label">{label}</div>
        </div>
      ))}
    </div>
  )
}

// ── Администраторы ────────────────────────────────────────────
function AdminsTab({ data, reload }) {
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ login: '', password: '', single_session: true })
  const [resetPwd, setResetPwd] = useState({})  // id → новый пароль
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true); setErr(null)
    try {
      await saCreateAdmin(form)
      setForm({ login: '', password: '', single_session: true })
      setShowCreate(false)
      reload()
    } catch (e) {
      setErr(e.message === 'login_taken' ? 'Логин занят.' : 'Ошибка.')
    } finally { setSaving(false) }
  }

  async function handleDelete(id, login) {
    if (!confirm(`Удалить администратора ${login}?`)) return
    await saDeleteAdmin(id); reload()
  }

  async function handleResetPwd(id) {
    const pwd = resetPwd[id]?.trim()
    if (!pwd || pwd.length < 6) return
    await saResetAdminPassword(id, pwd)
    setResetPwd(p => ({ ...p, [id]: '' }))
    alert('Пароль сброшен.')
  }

  return (
    <div className="sa-tab">
      <div className="sa-toolbar">
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(v => !v)}>
          {showCreate ? 'Отмена' : '+ Создать администратора'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="sa-form">
          <div className="field-row">
            <div className="field">
              <label>Логин</label>
              <input value={form.login} onChange={e => setForm(f => ({ ...f, login: e.target.value }))} required />
            </div>
            <div className="field">
              <label>Пароль</label>
              <input type="password" value={form.password}
                     onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required minLength={6} />
            </div>
            <div className="field field-checkbox">
              <label>
                <input type="checkbox" checked={form.single_session}
                       onChange={e => setForm(f => ({ ...f, single_session: e.target.checked }))} />
                Одна сессия
              </label>
            </div>
          </div>
          {err && <div className="form-error">{err}</div>}
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Сохранение...' : 'Создать'}
          </button>
        </form>
      )}

      <div className="sa-list">
        {(data || []).map(a => (
          <div key={a.id} className="sa-row">
            <div className="sa-row-main">
              <span className="sa-row-login">{a.login}</span>
              {a.display_name && <span className="sa-row-name">{a.display_name}</span>}
              {a.has_session && <span className="session-dot" title="Активная сессия">●</span>}
              {!a.is_active  && <span className="badge-inactive">заблокирован</span>}
              <span className={`badge-ss ${a.single_session ? 'on' : 'off'}`}>
                {a.single_session ? '🔒' : '🔓'}
              </span>
            </div>
            <div className="sa-row-groups">
              {(a.groups || []).map(g => (
                <span key={g.id} className="badge-group">{g.name}</span>
              ))}
            </div>
            <div className="sa-row-actions">
              <button className="btn btn-outline btn-xs"
                      onClick={() => saUpdateAdmin(a.id, { single_session: !a.single_session }).then(reload)}>
                {a.single_session ? '🔒' : '🔓'}
              </button>
              <button className="btn btn-outline btn-xs"
                      onClick={() => saUpdateAdmin(a.id, { is_active: !a.is_active }).then(reload)}>
                {a.is_active ? 'Блок' : 'Разблок'}
              </button>
              <button className="btn btn-outline btn-xs"
                      onClick={() => saResetAdminSessions(a.id).then(reload)}>
                ⏏ Сессия
              </button>
              <input className="input-inline" placeholder="Новый пароль"
                     value={resetPwd[a.id] || ''}
                     onChange={e => setResetPwd(p => ({ ...p, [a.id]: e.target.value }))} />
              <button className="btn btn-warning btn-xs" onClick={() => handleResetPwd(a.id)}>
                Сбросить пароль
              </button>
              <button className="btn btn-danger btn-xs" onClick={() => handleDelete(a.id, a.login)}>
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Группы ────────────────────────────────────────────────────
function GroupsTab({ data, reload }) {
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', mqtt_topic: '', relay_duration_ms: 500, user_quota: 0 })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true); setErr(null)
    try {
      await saCreateGroup(form)
      setForm({ name: '', mqtt_topic: '', relay_duration_ms: 500, user_quota: 0 })
      setShowCreate(false); reload()
    } catch (e) {
      setErr(e.message === 'mqtt_topic_taken' ? 'MQTT топик занят.' : 'Ошибка.')
    } finally { setSaving(false) }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Удалить группу "${name}"? Все пользователи без других групп будут удалены.`)) return
    await saDeleteGroup(id); reload()
  }

  return (
    <div className="sa-tab">
      <div className="sa-toolbar">
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(v => !v)}>
          {showCreate ? 'Отмена' : '+ Создать группу'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="sa-form">
          <div className="field-row">
            <div className="field">
              <label>Название</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="field">
              <label>MQTT топик</label>
              <input value={form.mqtt_topic}
                     onChange={e => setForm(f => ({ ...f, mqtt_topic: e.target.value }))} required />
            </div>
            <div className="field">
              <label>Длит. реле (мс, 0=триггер)</label>
              <input type="number" min="0" value={form.relay_duration_ms}
                     onChange={e => setForm(f => ({ ...f, relay_duration_ms: +e.target.value }))} />
            </div>
            <div className="field">
              <label>Квота (0=∞)</label>
              <input type="number" min="0" value={form.user_quota}
                     onChange={e => setForm(f => ({ ...f, user_quota: +e.target.value }))} />
            </div>
          </div>
          {err && <div className="form-error">{err}</div>}
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Сохранение...' : 'Создать'}
          </button>
        </form>
      )}

      <div className="sa-list">
        {(data || []).map(g => (
          <div key={g.id} className="sa-row">
            <div className="sa-row-main">
              <span className="sa-row-login">{g.name}</span>
              <span className="badge-topic">{g.mqtt_topic}</span>
              <span className={`badge-status ${g.status}`}>{g.status}</span>
              <span className="sa-row-meta">{g.user_count} польз. · {g.admin_count} адм.</span>
            </div>
            <div className="sa-row-admins">
              {(g.admins || []).map(a => (
                <span key={a.id} className="badge-admin">
                  {a.login}
                  <button className="badge-remove"
                          onClick={() => saRemoveGroupAdmin(g.id, a.id).then(reload)}>×</button>
                </span>
              ))}
            </div>
            <div className="sa-row-actions">
              <button className="btn btn-outline btn-xs"
                      onClick={() => saUpdateGroup(g.id, { status: g.status === 'active' ? 'blocked' : 'active' }).then(reload)}>
                {g.status === 'active' ? 'Блок' : 'Разблок'}
              </button>
              <button className="btn btn-danger btn-xs" onClick={() => handleDelete(g.id, g.name)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Пользователи ──────────────────────────────────────────────
function UsersTab({ data, reload }) {
  const [resetPwd, setResetPwd] = useState({})

  async function handleResetPwd(id) {
    const pwd = resetPwd[id]?.trim()
    if (!pwd || pwd.length < 6) return
    await saResetUserPassword(id, pwd)
    setResetPwd(p => ({ ...p, [id]: '' }))
    alert('Пароль сброшен.')
  }

  return (
    <div className="sa-tab">
      <div className="sa-list">
        {(data || []).map(u => (
          <div key={u.id} className="sa-row">
            <div className="sa-row-main">
              <span className="sa-row-login">{u.login}</span>
              {u.display_name && <span className="sa-row-name">{u.display_name}</span>}
              <span className={`user-role role-${u.role}`}>{u.role}</span>
              {u.has_session && <span className="session-dot">●</span>}
              {!u.is_active  && <span className="badge-inactive">заблокирован</span>}
              <span className="sa-row-meta">{u.group_count} групп</span>
            </div>
            <div className="sa-row-actions">
              <button className="btn btn-outline btn-xs"
                      onClick={() => saUpdateUser(u.id, { is_active: !u.is_active }).then(reload)}>
                {u.is_active ? 'Блок' : 'Разблок'}
              </button>
              <button className="btn btn-outline btn-xs"
                      onClick={() => saResetUserSessions(u.id).then(reload)}>
                ⏏ Сессия
              </button>
              <input className="input-inline" placeholder="Новый пароль"
                     value={resetPwd[u.id] || ''}
                     onChange={e => setResetPwd(p => ({ ...p, [u.id]: e.target.value }))} />
              <button className="btn btn-warning btn-xs" onClick={() => handleResetPwd(u.id)}>
                Сбросить пароль
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Устройства ────────────────────────────────────────────────
function DevicesTab({ data, reload }) {
  return (
    <div className="sa-tab">
      <div className="sa-list">
        {(data || []).map(d => (
          <div key={d.device_id} className="sa-row">
            <div className="sa-row-main">
              <span className={`device-dot ${d.is_online ? 'online' : 'offline'}`} />
              <span className="sa-row-login"><code>{d.device_id}</code></span>
              <span className="sa-row-meta">
                {d.fw_version || '—'} · {d.last_seen
                  ? new Date(d.last_seen).toLocaleString('ru') : 'никогда'}
              </span>
            </div>
            <div className="sa-row-groups">
              {(d.groups || []).filter(Boolean).map(g => (
                <span key={g.group_id} className="badge-group">{g.name}</span>
              ))}
            </div>
            <div className="sa-row-actions">
              <button className="btn btn-danger btn-xs"
                      onClick={() => { if (confirm('Удалить устройство?')) saDeleteDevice(d.device_id).then(reload) }}>
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Журнал ────────────────────────────────────────────────────
function LogsTab({ data, reload }) {
  return (
    <div className="sa-tab">
      <div className="sa-toolbar">
        <button className="btn btn-outline btn-sm" onClick={reload}>↻ Обновить</button>
      </div>
      <div className="logs-list">
        {(data || []).map(l => (
          <div key={l.id} className="log-entry">
            <span className="log-ts">{new Date(l.ts).toLocaleString('ru')}</span>
            <span className="log-actor">{l.actor_login || '—'}</span>
            <span className={`log-action action-${l.action}`}>{l.action}</span>
            {l.group_name && <span className="log-group">{l.group_name}</span>}
            {l.payload && (
              <span className="log-payload">{JSON.stringify(l.payload).substring(0, 80)}</span>
            )}
            {l.ip && <span className="log-ip">{l.ip}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── SQL ───────────────────────────────────────────────────────
function SqlTab() {
  const [sql, setSql]       = useState('')
  const [result, setResult] = useState(null)
  const [error, setError]   = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleRun(e) {
    e.preventDefault()
    setError(null); setResult(null); setLoading(true)
    try {
      const data = await saQuery(sql)
      setResult(data)
    } catch (e) {
      setError(e.body?.error || e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="sa-tab">
      <form onSubmit={handleRun} className="sql-form">
        <textarea
          className="sql-input"
          value={sql}
          onChange={e => setSql(e.target.value)}
          placeholder="SELECT * FROM users LIMIT 10;"
          rows={6}
          spellCheck={false}
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Выполнение...' : '▶ Выполнить'}
        </button>
      </form>

      {error && <div className="sa-error sql-error">{error}</div>}

      {result && (
        <div className="sql-result">
          <div className="sql-count">{result.count} строк</div>
          {result.rows?.length > 0 && (
            <div className="sql-table-wrap">
              <table className="sql-table">
                <thead>
                  <tr>{Object.keys(result.rows[0]).map(k => <th key={k}>{k}</th>)}</tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {Object.values(row).map((v, j) => (
                        <td key={j}>{v === null ? <i>null</i> : String(v).substring(0, 100)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
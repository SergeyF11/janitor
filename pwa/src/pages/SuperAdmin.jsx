import { useState, useEffect, useCallback } from 'react'
import {
  saGetStats, saGetAdmins, saCreateAdmin, saUpdateAdmin, saDeleteAdmin,
  saResetAdminSessions, saResetAdminPassword,
  saGetUsers, saGetGroups, saCreateGroup, saUpdateGroup, saDeleteGroup,
  saAssignGroupAdmin, saRemoveGroupAdmin,
  saUpdateUser, saResetUserPassword, saResetUserSessions, 
  saGetDevices, saDeleteDevice,
  saGetLogs, saQuery, logout
} from '../api'


const TABS = ['stats', 'admins', 'groups', 'users', 'devices', 'logs', 'sql']
const TAB_LABELS = {
  stats: 'Статистика', admins: 'Администраторы', groups: 'Группы',
  users: 'Пользователи', devices: 'Устройства', logs: 'Журнал', sql: 'SQL'
}

export default function SuperAdmin({ user, onLogout }) {
  const [tab, setTab]         = useState('stats')
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [pendingCreds, setPendingCreds] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const loaders = {
        stats:   saGetStats,
        admins:  saGetAdmins,
        groups:  saGetGroups,
        //users:   () => saGetUsers({ limit: 100 }),
        users:   () => Promise.resolve([]),   // <-- добавить эту строку
        devices: saGetDevices,
        logs:    () => saGetLogs({ limit: 100 }),
        sql:     () => Promise.resolve(null),
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

  function renderTab() {
    if (tab === 'sql') return <SqlTab />
    if (tab === 'stats') return <StatsTab data={data} />
    const arr = Array.isArray(data) ? data : []
    if (tab === 'admins')  return <AdminsTab  data={arr} reload={load} />
    if (tab === 'groups')  return <GroupsTab  data={arr} reload={load} onCreds={setPendingCreds} />
    if (tab === 'users')   return <UsersTab />  
    if (tab === 'devices') return <DevicesTab data={arr} reload={load} />
    if (tab === 'logs')    return <LogsTab    data={arr} reload={load} />
    return null
  }

  return (
    <div className="sa-screen">
      {pendingCreds && (
        <div className="sa-creds-modal">
          <div className="sa-creds-box">
            <div className="sa-creds-title">✅ Группа создана. Данные администратора:</div>
            <div className="sa-creds-row"><b>Логин:</b> <code>{pendingCreds.login}</code></div>
            <div className="sa-creds-row"><b>Пароль:</b> <code>{pendingCreds.password}</code></div>
            <div className="sa-creds-hint">Сохраните пароль — он больше не будет показан.</div>
            <button className="btn btn-primary" onClick={() => setPendingCreds(null)}>Понятно</button>
          </div>
        </div>
      )}
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
          {!loading && error && <div className="sa-error">{error}</div>}
          {!loading && !error && renderTab()}
        </main>
      </div>
    </div>
  )
}

// ── Статистика ────────────────────────────────────────────────
function StatsTab({ data }) {
  if (!data) return <div className="empty-state">Нет данных</div>
  const items = [
    { label: 'Пользователей',   value: data.total_users },
    { label: 'Администраторов', value: data.total_admins },
    { label: 'Групп',           value: data.total_groups },
    { label: 'Устройств',       value: data.total_devices },
    { label: 'Онлайн',          value: data.online_devices },
    { label: 'Активных сессий', value: data.active_sessions },
    { label: 'Событий за 24ч',  value: data.events_24h },
    { label: 'Входов за 24ч',   value: data.logins_24h },
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
  const [form, setForm]     = useState({ login: '', password: '', group_id: '', single_session: true }) //const [form, setForm]     = useState({ login: '', password: '', single_session: true })
  const [resetPwd, setResetPwd] = useState({})
  const [groups, setGroups] = useState([])
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState(null)

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true); setErr(null)
    try {
      await saCreateAdmin(form)
      setForm({ login: '', password: '', group_id: '', single_session: true }) //setForm({ login: '', password: '', single_session: true })
      setShowCreate(false)
      reload()
    } catch (e) {
      //setErr(e.message === 'login_taken' ? 'Логин занят.' : 'Ошибка: ' + e.message)
      setErr(e.message === 'login_taken' ? 'Логин в этой группе уже занят.' :
             e.message === 'group_not_found' ? 'Группа не найдена.' :
             e.message === 'login_too_short' ? 'Логин должен быть не короче 3 символов.' : 'Ошибка: ' + e.message)
    } finally { setSaving(false) }
  }

  async function handleDelete(id, login) {
    if (!confirm(`Удалить администратора ${login}?`)) return
    try { await saDeleteAdmin(id); reload() } catch (e) { alert(e.message) }
  }

  async function handleResetPwd(id) {
    const pwd = (resetPwd[id] || '').trim()
    if (pwd.length < 6) return alert('Минимум 6 символов')
    try {
      await saResetAdminPassword(id, pwd)
      setResetPwd(p => ({ ...p, [id]: '' }))
      alert('Пароль сброшен.')
    } catch (e) { alert(e.message) }
  }

  async function handleResetSession(id) {
    try { await saResetAdminSessions(id); reload() } catch (e) { alert(e.message) }
  }

  async function handleToggle(id, field, val) {
    try { await saUpdateAdmin(id, { [field]: val }); reload() } catch (e) { alert(e.message) }
  }

  useEffect(() => {
    saGetGroups().then(setGroups).catch(() => {})
  }, [])

  const selectedGroup = groups.find(g => g.id === form.group_id)
  const scopedPreview = form.login
    ? `${String(form.login).split('@')[0]}${selectedGroup?.mqtt_topic ? `@${selectedGroup.mqtt_topic}` : ''}`
    : ''


  function renderScopedLogin(login, group) {
    if (!login) return login
    if (login.includes('@')) return login
    if (group?.mqtt_topic) return `${login}@${group.mqtt_topic}`
    return login
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
              <input value={form.login}
                     onChange={e => setForm(f => ({ ...f, login: e.target.value }))}
                     required minLength={3} />
            </div>
            <div className="field">
              <label>Пароль</label>
              <input type="password" value={form.password}
                     onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                     required minLength={6} />
            </div>
             <div className="field">
              <label>Группа</label>
              <select value={form.group_id}
                      onChange={e => setForm(f => ({ ...f, group_id: e.target.value }))}
                      required>
                <option value="">— выберите группу —</option>
                {groups.map(gr => (
                  <option key={gr.id} value={gr.id}>{gr.name} ({gr.mqtt_topic})</option>
                ))}
              </select>
              {scopedPreview && <div className="sa-row-meta" style={{ marginTop: 6 }}>Логин: <code>{scopedPreview}</code></div>}
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
        {data.length === 0 && <div className="empty-state">Нет администраторов</div>}
        {data.map(a => (
          <div key={a.id} className="sa-row">
            <div className="sa-row-main">
              <span className="sa-row-login">{renderScopedLogin(a.login, (a.groups || [])[0])}</span>
              {a.has_session  && <span className="session-dot" title="Активная сессия">●</span>}
              {!a.is_active   && <span className="badge-inactive">заблокирован</span>}
              <span className={`badge-ss ${a.single_session ? 'on' : 'off'}`}>
                {a.single_session ? '🔒' : '🔓'}
              </span>
            </div>

            {(a.groups || []).length > 0 && (
              <div className="sa-row-groups" title="Администрируемые группы">
                {a.groups.map(g => (
                  <span key={g.id} className="badge-group">{g.name}</span>
                ))}
              </div>
            )}

            <div className="sa-row-actions">
              <button className="btn btn-outline btn-xs"
                      onClick={() => handleToggle(a.id, 'single_session', !a.single_session)}>
                {a.single_session ? '🔒 1 сессия' : '🔓 мульти'}
              </button>
              <button className="btn btn-outline btn-xs"
                      onClick={() => handleToggle(a.id, 'is_active', !a.is_active)}>
                {a.is_active ? 'Блок' : 'Разблок'}
              </button>
              <button className="btn btn-outline btn-xs"
                      onClick={() => handleResetSession(a.id)}>
                ⏏ Сессия
              </button>
              <input className="input-inline" placeholder="Новый пароль" type="password"
                     value={resetPwd[a.id] || ''}
                     onChange={e => setResetPwd(p => ({ ...p, [a.id]: e.target.value }))} />
              <button className="btn btn-warning btn-xs"
                      onClick={() => handleResetPwd(a.id)}>
                Сбросить пароль
              </button>
              <button className="btn btn-danger btn-xs"
                      onClick={() => handleDelete(a.id, a.login)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ── Транслитерация для mqtt_topic ─────────────────────────────
function toMqttTopic(str) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
    'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o',
    'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
    'ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
  }
  return str.toLowerCase()
    .split('').map(c => map[c] !== undefined ? map[c] : (/[a-z0-9]/.test(c) ? c : '_'))
    .join('').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 32) || 'group'
}

// ── Группы ────────────────────────────────────────────────────
function GroupsTab({ data, reload, onCreds }) {
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm]     = useState({ name: '', mqtt_topic: '', relay_duration_ms: 500, user_quota: 0 })
  const [assignId, setAssignId]       = useState({})   // groupId → selected adminId
  const [allAdmins, setAllAdmins]     = useState([])
  const [saving, setSaving]           = useState(false)
  const [err, setErr]                 = useState(null)
  const [editName, setEditName]       = useState({})   // groupId → string
  const [savingName, setSavingName]   = useState({})   // groupId → bool

  useEffect(() => {
    saGetAdmins().then(setAllAdmins).catch(() => {})
  }, [data])

  async function handleSaveName(g) {
    const newName = (editName[g.id] ?? g.name).trim()
    if (!newName || newName === g.name) {
      setEditName(t => { const c = { ...t }; delete c[g.id]; return c })
      return
    }
    setSavingName(s => ({ ...s, [g.id]: true }))
    try {
      await saUpdateGroup(g.id, { name: newName })
      setEditName(t => { const c = { ...t }; delete c[g.id]; return c })
      reload()
    } catch (e) {
      alert('Ошибка: ' + e.message)
    } finally {
      setSavingName(s => ({ ...s, [g.id]: false }))
    }
  }

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true); setErr(null)
    try {
      const result = await saCreateGroup(form)
      setForm({ name: '', mqtt_topic: '', relay_duration_ms: 500, user_quota: 0, _topic_edited: false })
      setShowCreate(false)
      reload()
      // if (result && result.admin_login) {
      //   onCreds({ login: result.admin_login, password: result.admin_password })
      if (result && (result.group_user_login || result.admin_login)) {
        onCreds({
          login: result.group_user_login || result.admin_login,
          password: result.group_user_password || result.admin_password,
        })
      }
    } catch (e) {
      setErr(e.message === 'mqtt_topic_tsetSavingTopic(s => ({ ...s, [g.id]: false }))aken' ? 'MQTT топик занят.' : 'Ошибка: ' + e.message)
    } finally { setSaving(false) }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Удалить группу "${name}"?\nПользователи без других групп будут удалены.`)) return
    try { await saDeleteGroup(id); reload() } catch (e) { alert(e.message) }
  }

  async function handleToggleStatus(g) {
    const newStatus = g.status === 'active' ? 'blocked' : 'active'
    try { await saUpdateGroup(g.id, { status: newStatus }); reload() } catch (e) { alert(e.message) }
  }

  async function handleAssignAdmin(groupId) {
    const id = (assignId[groupId] || '').trim()
    if (!id) return
    try {
      await saAssignGroupAdmin(groupId, id)
      setAssignId(a => ({ ...a, [groupId]: '' }))
      reload()
    } catch (e) {
      alert(e.message === 'user_not_found' ? 'Администратор не найден' :
            e.message === 'user_is_not_admin' ? 'Пользователь не является администратором' :
            e.message)
    }
  }

  async function handleRemoveAdmin(groupId, adminId) {
    try { await saRemoveGroupAdmin(groupId, adminId); reload() } catch (e) { alert(e.message) }
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
              <input value={form.name}
                     onChange={e => {
                       const name = e.target.value
                       setForm(f => ({
                         ...f,
                         name,
                         mqtt_topic: f._topic_edited ? f.mqtt_topic : toMqttTopic(name)
                       }))
                     }}
                     required />
            </div>
            <div className="field">
              <label>MQTT топик (авто)</label>
              <input value={form.mqtt_topic}
                     onChange={e => setForm(f => ({ ...f, mqtt_topic: e.target.value, _topic_edited: true }))}
                     placeholder="авто из названия" />
            </div>
            <div className="field">
              <label>Длит. реле мс (0=триггер)</label>
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
        {data.length === 0 && <div className="empty-state">Нет групп</div>}
        {data.map(g => (
          <div key={g.id} className="sa-row">
            <div className="sa-row-main">
              {editName[g.id] !== undefined ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <input
                    className="input-inline"
                    style={{ width: 140, fontSize: 12 }}
                    value={editName[g.id]}
                    onChange={e => setEditName(t => ({ ...t, [g.id]: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveName(g)
                      if (e.key === 'Escape') setEditName(t => { const c = { ...t }; delete c[g.id]; return c })
                    }}
                    autoFocus
                  />
                  <button className="btn btn-primary btn-xs"
                          disabled={savingName[g.id]}
                          onClick={() => handleSaveName(g)}>
                    {savingName[g.id] ? '...' : '✓'}
                  </button>
                  <button className="btn btn-outline btn-xs"
                          onClick={() => setEditName(t => { const c = { ...t }; delete c[g.id]; return c })}>
                    ✕
                  </button>
                </span>
              ) : (
                <span
                  className="sa-row-login"
                  title="Нажмите для редактирования имени группы"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setEditName(t => ({ ...t, [g.id]: g.name }))}
                >
                  {g.name}
                </span>
              )}
              <span className="badge-topic">{g.mqtt_topic}</span>
              <span className={`badge-status ${g.status}`}>{g.status}</span>
              <span className="sa-row-meta">
                {g.user_count} польз. · {g.admin_count} адм.
                {g.user_quota > 0 && ` · квота: ${g.user_quota}`}
              </span>
            </div>

            {/* Текущие администраторы группы */}
            {(g.admins || []).length > 0 && (
              <div className="sa-row-admins">
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>Адм: </span>
                {g.admins.map(a => (
                  <span key={a.id} className="badge-admin">
                    //{a.login}
                    {a.login.includes('@') ? a.login : `${a.login}@${g.mqtt_topic}`}
                    <button className="badge-remove"
                            onClick={() => handleRemoveAdmin(g.id, a.id)}>×</button>
                  </span>
                ))}
              </div>
            )}

            {/* Назначить администратора */}
            <div className="sa-row-actions">
              <select
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
                value={assignId[g.id] || ''}
                onChange={e => setAssignId(a => ({ ...a, [g.id]: e.target.value }))}
              >
                <option value="">— выбрать администратора —</option>
                {allAdmins.map(a => (
                  //<option key={a.id} value={a.id}>{a.login}</option>
                  <option key={a.id} value={a.id}>{a.login.includes('@') ? a.login : `${a.login}@${g.mqtt_topic}`}</option>
                ))}
              </select>
              <button className="btn btn-outline btn-xs"
                      onClick={() => handleAssignAdmin(g.id)}>
                + Назначить
              </button>
              <button className="btn btn-outline btn-xs"
                      onClick={() => handleToggleStatus(g)}>
                {g.status === 'active' ? 'Блок' : 'Разблок'}
              </button>
              <button className="btn btn-danger btn-xs"
                      onClick={() => handleDelete(g.id, g.name)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Пользователи ──────────────────────────────────────────────
function UsersTab() {


  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [groups, setGroups] = useState([])
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [roleFilter, setRoleFilter] = useState('')


  // Загрузить список групп для фильтра
  useEffect(() => {
    saGetGroups().then(setGroups).catch(() => {})
  }, [])

  // Загрузить пользователей при изменении фильтров
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const params = { limit: 100 }
        if (search) params.search = search
        if (groupFilter) params.group_id = groupFilter
        if (roleFilter) params.role = roleFilter
        const data = await saGetUsers(params)
        setUsers(data)
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [search, groupFilter, roleFilter])

  async function handleToggle(id, field, val) {
    if (field === 'is_active' && val === false) {
      const user = users.find(u => u.id === id)
      if (user?.role === 'superadmin') {
        alert('Нельзя заблокировать суперадмина')
        return
      }
    }
    try {
      await saUpdateUser(id, { [field]: val })
      // Обновить список после изменения
      const params = { limit: 100 }
      if (search) params.search = search
      if (groupFilter) params.group_id = groupFilter
      if (roleFilter) params.role = roleFilter
      const data = await saGetUsers(params)
      setUsers(data)
    } catch (e) { alert(e.message) }
  }

  async function handleResetSession(id) {
    try {
      await saResetUserSessions(id)
      // Обновить список
      const params = { limit: 100 }
      if (search) params.search = search
      if (groupFilter) params.group_id = groupFilter
      if (roleFilter) params.role = roleFilter
      const data = await saGetUsers(params)
      setUsers(data)
    } catch (e) { alert(e.message) }
  }

  return (
    <div className="sa-tab">
      <div className="filters" style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Поиск по логину, имени или ID"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="input-inline"
          style={{ flex: 1, minWidth: '200px' }}
        />
        <select
          value={groupFilter}
          onChange={e => setGroupFilter(e.target.value)}
          className="input-inline"
        >
          <option value="">Все группы</option>
          {groups.map(g => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <select
          value={roleFilter}
          onChange={e => setRoleFilter(e.target.value)}
          className="input-inline"
        >
          <option value="">Все роли</option>
          <option value="user">Пользователи</option>
          <option value="admin">Администраторы</option>
          <option value="superadmin">Суперадмины</option>
        </select>
      </div>

      {loading && <div className="sa-loading"><div className="spinner" /></div>}
      {!loading && (
        <div className="sa-list">
          {users.length === 0 && <div className="empty-state">Нет пользователей</div>}
          {users.map(u => (
            <div key={u.id} className="sa-row">
              <div className="sa-row-main">
                <span className="sa-row-login">{u.login}</span>
                {u.display_name && <span className="sa-row-name">{u.display_name}</span>}
                <span className={`user-role role-${u.role}`}>{u.role}</span>
                {u.has_session && <span className="session-dot" title="Активная сессия">●</span>}
                {!u.is_active && <span className="badge-inactive">заблокирован</span>}
                <span className="sa-row-meta">{u.group_count} групп</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text2)', marginTop: '4px' }}>
                ID: <code>{u.id}</code>
              </div>
              <div className="sa-row-actions">
                {u.role !== 'superadmin' && (
                  <button className="btn btn-outline btn-xs"
                          onClick={() => handleToggle(u.id, 'is_active', !u.is_active)}>
                    {u.is_active ? 'Блок' : 'Разблок'}
                  </button>
                )}
                {u.has_session && (
                  <button className="btn btn-outline btn-xs"
                          onClick={() => handleResetSession(u.id)}>
                    ⏏ Сессия
                  </button>
                )}
              </div>
            </div>
          ))} ✏️ {g.name}
        </div>
      )}
    </div>
  )
}


// ── Устройства ────────────────────────────────────────────────
function DevicesTab({ data, reload }) {
  async function handleDelete(deviceId) {
    if (!confirm(`Удалить устройство ${deviceId}?`)) return
    try { await saDeleteDevice(deviceId); reload() } catch (e) { alert(e.message) }
  }

  return (
    <div className="sa-tab">
      <div className="sa-list">
        {data.length === 0 && <div className="empty-state">Нет устройств</div>}
        {data.map(d => (
          <div key={d.device_id} className="sa-row">
            <div className="sa-row-main">
              <span className={`device-dot ${d.is_online ? 'online' : 'offline'}`} />
              <span className="sa-row-login"><code>{d.device_id}</code></span>
              <span className="sa-row-meta">
                {d.fw_version || '—'} · {d.last_seen
                  ? new Date(d.last_seen).toLocaleString('ru')
                  : 'никогда'}
              </span>
            </div>
            {(d.groups || []).filter(Boolean).length > 0 && (
              <div className="sa-row-groups">
                {d.groups.filter(Boolean).map(g => (
                  <span key={g.group_id} className="badge-group">{g.name}</span>
                ))}
              </div>
            )}
            <div className="sa-row-actions">
              <button className="btn btn-danger btn-xs"
                      onClick={() => handleDelete(d.device_id)}>✕</button>
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
        {data.length === 0 && <div className="empty-state">Нет событий</div>}
        {data.map(l => {
          let p = {}
          try { p = typeof l.payload === 'string' ? JSON.parse(l.payload) : (l.payload || {}) } catch {}
          const hasPayload = Object.keys(p).length > 0
          return (
            <div key={l.id} className="log-entry">
              <span className="log-ts">{new Date(l.ts).toLocaleString('ru')}</span>
              <span className="log-actor">{l.actor_login || '—'}</span>
              <span className={`log-action action-${l.action}`}>{l.action}</span>
              {l.group_name && <span className="log-group">{l.group_name}</span>}
              {hasPayload && (
                <span className="log-payload">
                  {Object.entries(p).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                </span>
              )}
              {l.ip && <span className="log-ip">{l.ip}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── SQL ───────────────────────────────────────────────────────
function SqlTab() {
  const [sql, setSql]         = useState('')
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState(null)
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
        <button type="submit" className="btn btn-primary" disabled={loading || !sql.trim()}>
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
                  <tr>
                    {Object.keys(result.rows[0]).map(k => <th key={k}>{k}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {Object.values(row).map((v, j) => (
                        <td key={j}>
                          {v === null ? <i style={{ color: 'var(--text2)' }}>null</i>
                                      : String(v).substring(0, 100)}
                        </td>
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

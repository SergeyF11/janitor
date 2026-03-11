// api.js — централизованный API клиент
// Все запросы идут через fetch с автоматическим refresh токена

const BASE = '/janitor/api'
let _accessToken = null
let _refreshTimer = null
let _onLogout     = null  // callback при выходе/инвалидации

// ── MQTT состояние ────────────────────────────────────────────
let _mqttClient   = null
let _mqttCreds    = null   // {host, username, password, devices}
let _onMqttStatus = null   // callback(connected: bool)

const MQTT_CREDS_KEY = 'janitor_mqtt_creds'

// ── Токен ─────────────────────────────────────────────────────
export function setAccessToken(token) {
  _accessToken = token
}

export function getAccessToken() {
  return _accessToken
}

export function setLogoutCallback(fn) {
  _onLogout = fn
}

// ── Базовый fetch с авто-refresh ──────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  // Content-Type только если есть тело — иначе Fastify вернёт 400
  if (opts.body) headers['Content-Type'] = 'application/json'
  if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`

  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers,
    credentials: 'include',  // для cookie refresh токена
  })

  // Попробовать обновить токен при 401
  if (res.status === 401) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      // Повторить запрос с новым токеном
      headers['Authorization'] = `Bearer ${_accessToken}`
      const retry = await fetch(`${BASE}${path}`, { ...opts, headers, credentials: 'include' })
      if (!retry.ok) throw await makeError(retry)
      return retry.json()
    } else {
      _onLogout?.()
      throw new Error('unauthorized')
    }
  }

  if (!res.ok) throw await makeError(res)
  if (res.status === 204) return null
  return res.json()
}

async function makeError(res) {
  try {
    const body = await res.json()
    const err = new Error(body.error || 'request_failed')
    err.status = res.status
    err.body = body
    return err
  } catch {
    return new Error(`HTTP ${res.status}`)
  }
}

// ── Refresh токена ────────────────────────────────────────────
async function tryRefresh() {
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    })
    if (!res.ok) return false
    const data = await res.json()
    _accessToken = data.accessToken
    scheduleRefresh()
    return true
  } catch {
    return false
  }
}

// Планировать обновление каждые 14 минут (токен живёт 15)
export function scheduleRefresh() {
  if (_refreshTimer) clearTimeout(_refreshTimer)
  _refreshTimer = setTimeout(async () => {
    const ok = await tryRefresh()
    if (!ok) _onLogout?.()
  }, 14 * 60 * 1000)
}

export function cancelRefresh() {
  if (_refreshTimer) clearTimeout(_refreshTimer)
  _refreshTimer = null
}

// ── Auth ──────────────────────────────────────────────────────
export async function login(loginStr, password) {
  const fingerprint = await getDeviceFingerprint()
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ login: loginStr, password, fingerprint }),
  })
  if (!res.ok) throw await makeError(res)
  const data = await res.json()
  _accessToken = data.accessToken
  scheduleRefresh()
  // Сохранить MQTT credentials если получены
  if (data.mqtt) {
    _mqttCreds = data.mqtt
    localStorage.setItem(MQTT_CREDS_KEY, JSON.stringify(data.mqtt))
    mqttConnect()
  }
  return data
}

export async function logout() {
  cancelRefresh()
  mqttDisconnect()
  try {
    await apiFetch('/auth/logout', { method: 'POST' })
  } catch {}
  _accessToken = null
}

export async function refreshOnStartup() {
  // Вызывается при загрузке приложения — восстановить сессию
  const ok = await tryRefresh()
  if (ok) {
    scheduleRefresh()
    // Восстановить MQTT соединение из сохранённых credentials
    const saved = localStorage.getItem(MQTT_CREDS_KEY)
    if (saved) {
      try {
        _mqttCreds = JSON.parse(saved)
        mqttConnect()
      } catch {}
    }
  }
  return ok
}

export async function changePassword(password) {
  return apiFetch('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export async function getMe() {
  return apiFetch('/auth/me')
}

// ── User ──────────────────────────────────────────────────────
export async function getMyGroups() {
  return apiFetch('/user/groups')
}

export async function triggerRelay(groupId, deviceId, mqttTopic, durationMs) {
  // Попытка через MQTT напрямую
  if (_mqttClient && _mqttClient.connected && deviceId) {
    const action = durationMs === 0 ? 'toggle' : 'pulse'
    const cmd = {
      group:  mqttTopic,
      action,
      ...(action === 'pulse' ? { duration: durationMs } : {}),
    }
    _mqttClient.publish(`$devices/${deviceId}/commands`, JSON.stringify(cmd), { qos: 1 })
    return { ok: true, via: 'mqtt' }
  }
  // Fallback — через бэкенд
  return apiFetch(`/user/groups/${groupId}/trigger`, { method: 'POST' })
}

export async function getMyProfile() {
  return apiFetch('/user/me')
}

// ── Admin: группы ─────────────────────────────────────────────
export async function getAdminGroups() {
  return apiFetch('/admin/groups')
}

export async function updateGroup(groupId, data) {
  return apiFetch(`/admin/groups/${groupId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// ── Admin: пользователи группы ────────────────────────────────
export async function getGroupUsers(groupId) {
  return apiFetch(`/admin/groups/${groupId}/users`)
}

// Создать нового пользователя
export async function createUser(groupId, { login, password, role = 'user', description, single_session, display_name, phone, email }) {
  return apiFetch(`/admin/groups/${groupId}/users`, {
    method: 'POST',
    body: JSON.stringify({ login, password, role, description, single_session, display_name, phone, email }),
  })
}

// Добавить существующего пользователя по ID
export async function addUserById(groupId, userId, description) {
  return apiFetch(`/admin/groups/${groupId}/users`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, description }),
  })
}

export async function updateUserDescription(groupId, userId, description) {
  return apiFetch(`/admin/groups/${groupId}/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ description }),
  })
}

export async function removeUserFromGroup(groupId, userId) {
  return apiFetch(`/admin/groups/${groupId}/users/${userId}`, { method: 'DELETE' })
}

// ── Admin: сессии и флаги ─────────────────────────────────────
export async function adminResetUserPassword(userId, password) {
  return apiFetch(`/admin/users/${userId}/password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export async function resetUserSessions(userId) {
  return apiFetch(`/admin/users/${userId}/reset-sessions`, { method: 'POST' })
}

export async function updateSingleSession(userId, single_session) {
  return apiFetch(`/admin/users/${userId}/single-session`, {
    method: 'PATCH',
    body: JSON.stringify({ single_session }),
  })
}

// ── Admin: устройства ─────────────────────────────────────────
export async function adminTriggerRelay(groupId, relayIndex = 0) {
  return apiFetch(`/admin/groups/${groupId}/trigger`, {
    method: 'POST',
    body: JSON.stringify({ relay: relayIndex }),
  })
}

export async function getGroupDevice(groupId) {
  return apiFetch(`/admin/groups/${groupId}/device`)
}

export async function generateDeviceToken(groupId) {
  return apiFetch(`/admin/groups/${groupId}/device-token`, { method: 'POST' })
}

// ── Admin: журнал ─────────────────────────────────────────────
export async function getGroupLogs(groupId, limit = 50, offset = 0) {
  return apiFetch(`/admin/groups/${groupId}/logs?limit=${limit}&offset=${offset}`)
}

// ── SuperAdmin ────────────────────────────────────────────────
export async function saGetAdmins() {
  return apiFetch('/sa/admins')
}

export async function saCreateAdmin(data) {
  return apiFetch('/sa/admins', { method: 'POST', body: JSON.stringify(data) })
}

export async function saUpdateAdmin(id, data) {
  return apiFetch(`/sa/admins/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
}

export async function saDeleteAdmin(id) {
  return apiFetch(`/sa/admins/${id}`, { method: 'DELETE' })
}

export async function saResetAdminSessions(id) {
  return apiFetch(`/sa/admins/${id}/reset-sessions`, { method: 'POST' })
}

export async function saResetAdminPassword(id, password) {
  return apiFetch(`/sa/admins/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) })
}

export async function saGetGroups() {
  return apiFetch('/sa/groups')
}

export async function saCreateGroup(data) {
  return apiFetch('/sa/groups', { method: 'POST', body: JSON.stringify(data) })
}

export async function saUpdateGroup(id, data) {
  return apiFetch(`/sa/groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
}

export async function saDeleteGroup(id) {
  return apiFetch(`/sa/groups/${id}`, { method: 'DELETE' })
}

export async function saAssignGroupAdmin(groupId, adminId) {
  return apiFetch(`/sa/groups/${groupId}/admins`, {
    method: 'POST',
    body: JSON.stringify({ admin_id: adminId }),
  })
}

export async function saRemoveGroupAdmin(groupId, adminId) {
  return apiFetch(`/sa/groups/${groupId}/admins/${adminId}`, { method: 'DELETE' })
}

export async function saGetUsers(params = {}) {
  const q = new URLSearchParams(params).toString()
  return apiFetch(`/sa/users${q ? '?' + q : ''}`)
}

export async function saUpdateUser(id, data) {
  return apiFetch(`/sa/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
}

export async function saResetUserPassword(id, password) {
  return apiFetch(`/sa/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) })
}

export async function saResetUserSessions(id) {
  return apiFetch(`/sa/users/${id}/reset-sessions`, { method: 'POST' })
}

export async function saGetDevices() {
  return apiFetch('/sa/devices')
}

export async function saDeleteDevice(deviceId) {
  return apiFetch(`/sa/devices/${deviceId}`, { method: 'DELETE' })
}

export async function saGetLogs(params = {}) {
  const q = new URLSearchParams(params).toString()
  return apiFetch(`/sa/logs${q ? '?' + q : ''}`)
}

export async function saGetStats() {
  return apiFetch('/sa/stats')
}

export async function saQuery(sql) {
  return apiFetch('/sa/query', { method: 'POST', body: JSON.stringify({ sql }) })
}

// ── WebSocket (бэкенд → PWA) ─────────────────────────────────
export function createWsConnection(onMessage) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url   = `${proto}://${window.location.host}/janitor/api/ws?token=${_accessToken}`
  const ws    = new WebSocket(url)

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }
      onMessage(msg)
    } catch {}
  }

  ws.onerror = (e) => console.warn('[ws] error (нет MQTT/WS — нормально для dev)', e)

  return ws
}

// ── MQTT (PWA → ESP напрямую) ─────────────────────────────────
export function mqttConnect(onStatus) {
  if (onStatus) _onMqttStatus = onStatus
  if (!_mqttCreds) return

  // Динамически импортируем mqtt.js (CDN или bundled)
  import('mqtt').then((mqttModule) => {
    const connect = mqttModule.connect || mqttModule.default?.connect || mqttModule.default
    if (_mqttClient) {
      try { _mqttClient.end(true) } catch {}
    }

    if (!connect) { console.warn('[mqtt] connect not found in module'); return }
    _mqttClient = connect(_mqttCreds.host, {
      username:        _mqttCreds.username,
      password:        _mqttCreds.password,
      clientId:        `pwa_${_mqttCreds.username}_${Date.now()}`,
      clean:           true,
      reconnectPeriod: 5000,
    })

    _mqttClient.on('connect', () => {
      console.log('[mqtt] PWA connected')
      _onMqttStatus?.(true)
    })

    _mqttClient.on('close', () => {
      console.log('[mqtt] PWA disconnected')
      _onMqttStatus?.(false)
    })

    _mqttClient.on('error', (e) => {
      console.warn('[mqtt] PWA error:', e.message)
      _onMqttStatus?.(false)
    })
  }).catch(e => {
    console.warn('[mqtt] failed to load mqtt.js:', e.message)
  })
}

export function mqttDisconnect() {
  if (_mqttClient) {
    try { _mqttClient.end(true) } catch {}
    _mqttClient = null
  }
  _onMqttStatus?.(false)
}

export function isMqttConnected() {
  return !!(_mqttClient && _mqttClient.connected)
}

// ── Device fingerprint ────────────────────────────────────────
function getCanvasHash() {
  try {
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')
    ctx.textBaseline = 'top'
    ctx.font = '14px Arial'
    ctx.fillText('fingerprint🖋', 2, 2)
    return c.toDataURL().slice(-32)
  } catch { return 'nocanvas' }
}

export async function getDeviceFingerprint() {
  const stored = localStorage.getItem('_did')
  const uuid   = stored || crypto.randomUUID()
  if (!stored) localStorage.setItem('_did', uuid)
  const canvas = getCanvasHash()
  const ua     = navigator.userAgent.slice(0, 40)
  return `${uuid}|${canvas}|${ua}`
}

export async function importUsersFromGroup(groupId, sourceGroupId) {
  return apiFetch(`/admin/groups/${groupId}/import-from/${sourceGroupId}`, { method: 'POST' })
}

export async function getAdminUsers() {
  return apiFetch('/admin/users')
}
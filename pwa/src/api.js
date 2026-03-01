import axios from 'axios'

const BASE = '/janitor/api'

const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' }
})

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      window.location.href = '/janitor/'
    }
    return Promise.reject(error)
  }
)

// ── Auth ──────────────────────────────────────────────────────
export const login = (login, password) =>
  api.post('/auth/login', { login, password })

export const logout = () =>
  api.post('/auth/logout')

export const getMe = () =>
  api.get('/auth/me')

// ── User ──────────────────────────────────────────────────────
export const getMyGroups = () =>
  api.get('/user/groups')

export const triggerRelay = (groupId) =>
  api.post(`/user/groups/${groupId}/trigger`)

// ── Admin ─────────────────────────────────────────────────────
export const getAdminGroups = () =>
  api.get('/admin/groups')

export const getGroupUsers = (groupId) =>
  api.get(`/admin/groups/${groupId}/users`)

export const addUserToGroup = (groupId, login, password, role, single_session = true) =>
  api.post(`/admin/groups/${groupId}/users`, { login, password, role, single_session })

export const removeUserFromGroup = (groupId, userId) =>
  api.delete(`/admin/groups/${groupId}/users/${userId}`)

export const getGroupLogs = (groupId) =>
  api.get(`/admin/groups/${groupId}/logs`)

export const resetUserSession = (userId) =>
  api.post(`/admin/users/${userId}/reset-session`)

export const updateSingleSession = (userId, single_session) =>
  api.patch(`/admin/users/${userId}/single-session`, { single_session })

export const updateGroup = (groupId, data) =>
  api.patch(`/admin/groups/${groupId}`, data)

// ── SuperAdmin ────────────────────────────────────────────────
export const getAdmins = () =>
  api.get('/sa/admins')

export const createAdmin = (login, password, single_session = true) =>
  api.post('/sa/admins', { login, password, single_session })

export const getSaGroups = () =>
  api.get('/sa/groups')

export const createGroup = (name, mqtt_topic, relay_duration_ms) =>
  api.post('/sa/groups', { name, mqtt_topic, relay_duration_ms })

export const assignGroupAdmin = (groupId, adminId) =>
  api.post(`/sa/groups/${groupId}/admins`, { admin_id: adminId })

export const getSaLogs = () =>
  api.get('/sa/logs')

// ── Device tokens ─────────────────────────────────────────────
export const generateDeviceToken = (groupId) =>
  api.post(`/admin/groups/${groupId}/device-token`)

export const getDeviceStatus = (groupId) =>
  api.get(`/admin/groups/${groupId}/device`)

export default api
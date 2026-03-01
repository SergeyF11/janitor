import { useState, useEffect } from 'react'
import {
  getAdmins, createAdmin,
  getSaGroups, createGroup, assignGroupAdmin,
  getSaLogs, updateSingleSession
} from '../api'

export default function SuperAdmin({ user, onBack }) {
  const [tab, setTab] = useState('groups')
  const [groups, setGroups] = useState([])
  const [admins, setAdmins] = useState([])
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [showAddGroup, setShowAddGroup] = useState(false)
  const [showAddAdmin, setShowAddAdmin] = useState(false)
  const [newGroup, setNewGroup] = useState({ name: '', mqtt_topic: '', relay_duration_ms: 500 })
  const [newAdmin, setNewAdmin] = useState({ login: '', password: '', single_session: true })
  const [assignModal, setAssignModal] = useState(null)
  const [selectedAdmin, setSelectedAdmin] = useState('')

  useEffect(() => { loadAll() }, [])

  const loadAll = async () => {
    setLoading(true)
    try {
      const [g, a, l] = await Promise.all([getSaGroups(), getAdmins(), getSaLogs()])
      setGroups(g.data)
      setAdmins(a.data)
      setLogs(l.data)
    } catch (err) {
      setError('Ошибка загрузки данных')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateGroup = async () => {
    if (!newGroup.name || !newGroup.mqtt_topic) {
      setError('Заполните название и MQTT топик')
      return
    }
    setError('')
    try {
      await createGroup(newGroup.name, newGroup.mqtt_topic, parseInt(newGroup.relay_duration_ms))
      setSuccess(`Группа "${newGroup.name}" создана`)
      setNewGroup({ name: '', mqtt_topic: '', relay_duration_ms: 500 })
      setShowAddGroup(false)
      loadAll()
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError(err.response?.data?.message || 'Ошибка создания группы')
    }
  }

  const handleCreateAdmin = async () => {
    if (!newAdmin.login || !newAdmin.password) {
      setError('Заполните логин и пароль')
      return
    }
    setError('')
    try {
      await createAdmin(newAdmin.login, newAdmin.password, newAdmin.single_session)
      setSuccess(`Администратор "${newAdmin.login}" создан`)
      setNewAdmin({ login: '', password: '', single_session: true })
      setShowAddAdmin(false)
      loadAll()
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError(err.response?.data?.message || 'Ошибка создания администратора')
    }
  }

  const handleToggleSingleSession = async (adminId, current) => {
    try {
      await updateSingleSession(adminId, !current)
      setAdmins(prev => prev.map(a =>
        a.id === adminId ? { ...a, single_session: !current } : a
      ))
    } catch (err) {
      setError(err.response?.data?.error || 'Ошибка изменения флага')
      setTimeout(() => setError(''), 3000)
    }
  }

  const handleAssignAdmin = async () => {
    if (!selectedAdmin) return
    try {
      await assignGroupAdmin(assignModal, selectedAdmin)
      setSuccess('Администратор назначен')
      setAssignModal(null)
      setSelectedAdmin('')
      loadAll()
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError('Ошибка назначения администратора')
    }
  }

  const formatDate = (ts) => new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })

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
        <span style={styles.headerTitle}>👑 Суперадмин</span>
      </div>

      {/* Вкладки */}
      <div style={styles.tabs}>
        {[
          { key: 'groups', label: '🔌 Группы' },
          { key: 'admins', label: '👤 Админы' },
          { key: 'logs',   label: '📋 Журнал' },
        ].map(t => (
          <button
            key={t.key}
            style={{ ...styles.tab, borderBottom: tab === t.key ? '2px solid #e94560' : 'none' }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error   && <p style={styles.error}>{error}</p>}
      {success && <p style={styles.success}>{success}</p>}

      <div style={styles.content}>

        {/* ── Группы ─────────────────────────────────────── */}
        {tab === 'groups' && (
          <div style={styles.section}>
            <button style={styles.addBtn} onClick={() => setShowAddGroup(!showAddGroup)}>
              {showAddGroup ? '✕ Отмена' : '+ Создать группу'}
            </button>

            {showAddGroup && (
              <div style={styles.addForm}>
                <input
                  style={styles.input}
                  placeholder="Название (напр. Ворота)"
                  value={newGroup.name}
                  onChange={e => setNewGroup({ ...newGroup, name: e.target.value })}
                />
                <input
                  style={styles.input}
                  placeholder="MQTT топик (напр. gates)"
                  value={newGroup.mqtt_topic}
                  onChange={e => setNewGroup({ ...newGroup, mqtt_topic: e.target.value.toLowerCase().replace(/\s/g, '_') })}
                  autoCapitalize="none"
                />
                <div style={styles.row}>
                  <span style={styles.label}>Режим реле:</span>
                  <select
                    style={{ ...styles.input, flex: 1 }}
                    value={newGroup.relay_duration_ms === 0 ? 'toggle' : 'pulse'}
                    onChange={e => setNewGroup({
                      ...newGroup,
                      relay_duration_ms: e.target.value === 'toggle' ? 0 : 500
                    })}
                  >
                    <option value="pulse">⚡ Импульс</option>
                    <option value="toggle">○ Триггер (вкл/выкл)</option>
                  </select>
                </div>
                {newGroup.relay_duration_ms > 0 && (
                  <div style={styles.row}>
                    <span style={styles.label}>Длительность, мс:</span>
                    <input
                      style={{ ...styles.input, flex: 1 }}
                      type="number"
                      min="100"
                      max="10000"
                      value={newGroup.relay_duration_ms}
                      onChange={e => setNewGroup({ ...newGroup, relay_duration_ms: parseInt(e.target.value) })}
                    />
                  </div>
                )}
                <button style={styles.saveBtn} onClick={handleCreateGroup}>
                  Создать
                </button>
              </div>
            )}

            <div style={styles.list}>
              {groups.map(g => (
                <div key={g.id} style={styles.card}>
                  <div style={styles.cardHeader}>
                    <span style={styles.cardTitle}>{g.name}</span>
                    <span style={styles.badge}>
                      {g.relay_duration_ms > 0 ? `⚡ ${g.relay_duration_ms}мс` : '○ Триггер'}
                    </span>
                  </div>
                  <div style={styles.cardMeta}>
                    <span style={styles.metaText}>📡 {g.mqtt_topic}</span>
                    <span style={styles.metaText}>👥 {g.member_count} польз.</span>
                  </div>
                  {g.admins && g.admins.length > 0 && (
                    <div style={styles.adminsList}>
                      <span style={styles.adminsLabel}>Администраторы: </span>
                      {g.admins.map(a => (
                        <span key={a.id} style={styles.adminTag}>{a.login}</span>
                      ))}
                    </div>
                  )}
                  <button
                    style={styles.assignBtn}
                    onClick={() => { setAssignModal(g.id); setSelectedAdmin('') }}
                  >
                    Назначить администратора
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Администраторы ──────────────────────────────── */}
        {tab === 'admins' && (
          <div style={styles.section}>
            <button style={styles.addBtn} onClick={() => setShowAddAdmin(!showAddAdmin)}>
              {showAddAdmin ? '✕ Отмена' : '+ Создать администратора'}
            </button>

            {showAddAdmin && (
              <div style={styles.addForm}>
                <input
                  style={styles.input}
                  placeholder="Логин"
                  value={newAdmin.login}
                  onChange={e => setNewAdmin({ ...newAdmin, login: e.target.value })}
                  autoCapitalize="none"
                />
                <input
                  style={styles.input}
                  type="password"
                  placeholder="Пароль"
                  value={newAdmin.password}
                  onChange={e => setNewAdmin({ ...newAdmin, password: e.target.value })}
                />
                <label style={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={newAdmin.single_session}
                    onChange={e => setNewAdmin({ ...newAdmin, single_session: e.target.checked })}
                  />
                  <span style={styles.checkLabel}>Одна сессия (один вход)</span>
                </label>
                <button style={styles.saveBtn} onClick={handleCreateAdmin}>
                  Создать
                </button>
              </div>
            )}

            <div style={styles.list}>
              {admins.map(a => (
                <div key={a.id} style={styles.userRow}>
                  <span style={styles.userName}>{a.login}</span>
                  <div style={styles.userActions}>
                    <span style={styles.metaText}>{formatDate(a.created_at)}</span>
                    <label style={styles.toggleRow}>
                      <input
                        type="checkbox"
                        checked={!!a.single_session}
                        onChange={() => handleToggleSingleSession(a.id, !!a.single_session)}
                      />
                      <span style={{ ...styles.metaText, marginLeft: 4 }}>1 сессия</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Журнал ──────────────────────────────────────── */}
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
                  <span style={styles.logUser}>{log.actor_login}</span>
                  <span style={styles.logAction}>{log.action}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Модальное окно назначения администратора */}
      {assignModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <h3 style={styles.modalTitle}>Назначить администратора</h3>
            <select
              style={styles.input}
              value={selectedAdmin}
              onChange={e => setSelectedAdmin(e.target.value)}
            >
              <option value="">— Выберите администратора —</option>
              {admins.filter(a => a.login !== 'superadmin').map(a => (
                <option key={a.id} value={a.id}>{a.login}</option>
              ))}
            </select>
            <div style={styles.modalButtons}>
              <button style={styles.cancelBtn} onClick={() => setAssignModal(null)}>
                Отмена
              </button>
              <button style={styles.saveBtn} onClick={handleAssignAdmin}>
                Назначить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh', background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)' },
  header: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', background: '#0f3460', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', minHeight: '56px' },
  headerTitle: { fontSize: '16px', fontWeight: 'bold', color: '#eee' },
  backBtn: { background: 'transparent', color: '#e94560', fontSize: '16px', padding: '4px 8px', borderRadius: '8px' },
  tabs: { display: 'flex', background: '#16213e', borderBottom: '1px solid #1a4a7a' },
  tab: { flex: 1, padding: '12px', background: 'transparent', color: '#eee', fontSize: '13px', borderRadius: 0 },
  content: { flex: 1, overflowY: 'auto' },
  section: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  addBtn: { background: '#1a4a7a', color: 'white', padding: '12px', borderRadius: '8px', fontSize: '15px', width: '100%' },
  addForm: { background: '#0f3460', borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' },
  input: { padding: '12px', borderRadius: '8px', border: '1px solid #1a4a7a', background: '#16213e', color: '#eee', fontSize: '15px', width: '100%' },
  saveBtn: { background: '#e94560', color: 'white', padding: '12px', borderRadius: '8px', fontSize: '15px', fontWeight: 'bold' },
  checkRow: { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '4px 0' },
  checkLabel: { color: '#eee', fontSize: '14px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  card: { background: '#0f3460', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: '16px', fontWeight: 'bold' },
  badge: { fontSize: '12px', background: '#1a4a7a', padding: '4px 10px', borderRadius: '12px', color: '#eee' },
  cardMeta: { display: 'flex', gap: '12px' },
  metaText: { fontSize: '12px', color: '#aaa' },
  assignBtn: { background: '#1a4a7a', color: 'white', padding: '8px 12px', borderRadius: '8px', fontSize: '13px', alignSelf: 'flex-start' },
  userRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#0f3460', borderRadius: '10px', padding: '12px 16px' },
  userName: { fontSize: '15px' },
  userActions: { display: 'flex', alignItems: 'center', gap: '12px' },
  toggleRow: { display: 'flex', alignItems: 'center', cursor: 'pointer' },
  logRow: { display: 'flex', gap: '8px', alignItems: 'center', background: '#0f3460', borderRadius: '10px', padding: '10px 12px', flexWrap: 'wrap' },
  logTime: { fontSize: '12px', color: '#aaa', whiteSpace: 'nowrap' },
  logUser: { fontSize: '13px', color: '#e94560', fontWeight: 'bold' },
  logAction: { fontSize: '13px', color: '#eee' },
  row: { display: 'flex', alignItems: 'center', gap: '10px' },
  label: { fontSize: '14px', color: '#aaa', whiteSpace: 'nowrap' },
  error: { color: '#e94560', padding: '8px 16px', fontSize: '14px' },
  success: { color: '#27ae60', padding: '8px 16px', fontSize: '14px' },
  center: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', zIndex: 100 },
  modal: { background: '#0f3460', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '360px', display: 'flex', flexDirection: 'column', gap: '16px' },
  modalTitle: { fontSize: '18px', fontWeight: 'bold', textAlign: 'center' },
  modalButtons: { display: 'flex', gap: '10px' },
  cancelBtn: { flex: 1, background: '#1a4a7a', color: 'white', padding: '12px', borderRadius: '8px', fontSize: '15px' },
  adminsList: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  adminsLabel: { fontSize: '12px', color: '#aaa' },
  adminTag: { fontSize: '12px', background: '#e9456033', color: '#e94560', padding: '2px 8px', borderRadius: '10px', border: '1px solid #e9456066' },
}
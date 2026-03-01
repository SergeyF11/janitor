import { useState, useEffect, useRef, useCallback } from 'react'
import { getMyGroups, getMyProfile, triggerRelay, logout, createWsConnection } from '../api'

export default function Main({ user, onLogout }) {
  const [groups, setGroups]       = useState([])
  const [profile, setProfile]     = useState(null)
  const [loading, setLoading]     = useState(true)
  const [pressing, setPressing]   = useState({})   // groupId → bool
  const [statuses, setStatuses]   = useState({})   // mqttTopic → { state, online }
  const [showProfile, setShowProfile] = useState(false)
  const wsRef = useRef(null)

  const loadData = useCallback(async () => {
    try {
      const [g, p] = await Promise.all([getMyGroups(), getMyProfile()])
      setGroups(g)
      setProfile(p)
      // Инициализировать статусы из данных групп
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

  // WebSocket для realtime обновлений
  useEffect(() => {
    loadData()

    const ws = createWsConnection((msg) => {
      if (msg.type === 'relay_status') {
        setStatuses(s => ({
          ...s,
          [msg.topic]: { ...s[msg.topic], state: msg.state }
        }))
      }
      if (msg.type === 'device_status') {
        setGroups(g => g.map(gr => {
          const dg = gr.device_id === msg.device_id
          return dg ? { ...gr, device_online: msg.online } : gr
        }))
      }
    })
    wsRef.current = ws

    return () => ws.close()
  }, [loadData])

  async function handleTrigger(group) {
    if (pressing[group.id]) return
    setPressing(p => ({ ...p, [group.id]: true }))
    try {
      const result = await triggerRelay(group.id)
      setStatuses(s => ({
        ...s,
        [group.mqtt_topic]: { ...s[group.mqtt_topic], state: result.state }
      }))
    } catch (err) {
      console.error('trigger error', err)
    } finally {
      // Небольшая задержка для визуальной обратной связи
      setTimeout(() => setPressing(p => ({ ...p, [group.id]: false })), 300)
    }
  }

  async function handleLogout() {
    await logout()
    onLogout()
  }

  if (loading) {
    return (
      <div className="app-loading">
        <div className="spinner" />
      </div>
    )
  }

  return (
    <div className="main-screen">
      {/* Шапка */}
      <header className="main-header">
        <h1 className="main-title">Привратник</h1>
        <button
          className="btn-icon"
          onClick={() => setShowProfile(p => !p)}
          title="Профиль"
        >
          👤
        </button>
      </header>

      {/* Профиль */}
      {showProfile && (
        <div className="profile-panel">
          <div className="profile-info">
            <div className="profile-login">{profile?.login}</div>
            {profile?.display_name && (
              <div className="profile-name">{profile.display_name}</div>
            )}
            <div className="profile-id">
              <span className="profile-id-label">Ваш ID:</span>
              <code className="profile-id-value">{profile?.id}</code>
              <button
                className="btn-copy"
                onClick={() => navigator.clipboard?.writeText(profile?.id)}
                title="Скопировать"
              >
                📋
              </button>
            </div>
          </div>
          <button className="btn btn-outline btn-sm" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      )}

      {/* Группы / кнопки */}
      <div className="groups-list">
        {groups.length === 0 && (
          <div className="empty-state">
            <p>Нет доступных групп.</p>
            <p className="empty-hint">Обратитесь к администратору.</p>
          </div>
        )}

        {groups.map(group => {
          const status  = statuses[group.mqtt_topic] || {}
          const online  = status.online || group.device_online
          const state   = status.state
          const isPulse = group.relay_duration_ms > 0
          const isOn    = state === 'on'
          const busy    = pressing[group.id]

          return (
            <div key={group.id} className="group-card">
              {/* Заголовок группы */}
              <div className="group-header">
                <div className="group-name">{group.name}</div>
                <div className={`device-dot ${online ? 'online' : 'offline'}`}
                     title={online ? 'Устройство онлайн' : 'Устройство оффлайн'} />
              </div>

              {group.description && (
                <div className="group-description">{group.description}</div>
              )}

              {/* Кнопка управления */}
              <button
                className={[
                  'relay-btn',
                  isPulse ? 'relay-pulse' : (isOn ? 'relay-on' : 'relay-off'),
                  busy ? 'relay-busy' : '',
                  !online ? 'relay-offline' : '',
                ].join(' ')}
                onClick={() => handleTrigger(group)}
                disabled={busy}
              >
                {busy ? (
                  <span className="relay-btn-spinner" />
                ) : isPulse ? (
                  '▶ Открыть'
                ) : isOn ? (
                  '● Включено'
                ) : (
                  '○ Выключено'
                )}
              </button>

              {!online && (
                <div className="group-offline-hint">Устройство недоступно</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
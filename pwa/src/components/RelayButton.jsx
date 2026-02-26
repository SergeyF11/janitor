import { useState } from 'react'
import { triggerRelay } from '../api'

export default function RelayButton({ group, onStateChange }) {
  const [loading, setLoading] = useState(false)
  const [feedback, setFeedback] = useState(null) // 'success' | 'error'

  const isPulse = group.relay_duration_ms > 0
  const isOn = group.relay_state

  const handlePress = async () => {
    if (loading) return
    setLoading(true)
    setFeedback(null)

    // Тактильная отдача на мобильных
    if (navigator.vibrate) navigator.vibrate(50)

    try {
      const res = await triggerRelay(group.id)
      setFeedback('success')

      // Для триггерного режима обновить состояние
      if (!isPulse && onStateChange) {
        onStateChange(group.id, res.data.state)
      }

      // Убрать подсветку через 600мс
      setTimeout(() => setFeedback(null), 600)
    } catch (err) {
      setFeedback('error')
      setTimeout(() => setFeedback(null), 1000)
    } finally {
      // Для импульса ждём длительность реле перед разблокировкой
      const delay = isPulse ? Math.min(group.relay_duration_ms, 1000) : 300
      setTimeout(() => setLoading(false), delay)
    }
  }

  // Определяем цвет кнопки
  const getBackground = () => {
    if (feedback === 'error') return 'linear-gradient(135deg, #c0392b, #e74c3c)'
    if (feedback === 'success') return 'linear-gradient(135deg, #27ae60, #2ecc71)'
    if (!isPulse && isOn) return 'linear-gradient(135deg, #1a6b3c, #27ae60)'
    return 'linear-gradient(135deg, #0f3460, #16213e)'
  }

  const getBorder = () => {
    if (feedback === 'success') return '2px solid #2ecc71'
    if (feedback === 'error') return '2px solid #e74c3c'
    if (!isPulse && isOn) return '2px solid #27ae60'
    return '2px solid #1a4a7a'
  }

  return (
    <button
      onClick={handlePress}
      disabled={loading}
      style={{
        background: getBackground(),
        border: getBorder(),
        borderRadius: '16px',
        color: 'white',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '16px',
        width: '100%',
        height: '100%',
        transition: 'all 0.15s ease',
        transform: loading ? 'scale(0.96)' : 'scale(1)',
        boxShadow: loading
          ? 'none'
          : '0 4px 15px rgba(0,0,0,0.3)',
        cursor: loading ? 'not-allowed' : 'pointer',
      }}
    >
      {/* Иконка состояния */}
      <span style={{ fontSize: '48px' }}>
        {feedback === 'error' ? '✗' :
         feedback === 'success' ? '✓' :
         isPulse ? '⚡' :
         isOn ? '●' : '○'}
      </span>

{/* Название канала */}
      <span style={{
        fontSize: '24px',
        fontWeight: 'bold',
        textAlign: 'center',
        lineHeight: 1.2,
      }}>
        {group.name}
      </span>

      {/* Подпись режима */}
      <span style={{ fontSize: '16px', color: '#aaa', marginTop: '4px' }}>
        {isPulse
          ? `⚡ ${group.relay_duration_ms}мс`
          : isOn ? '● ВКЛ' : '○ ВЫКЛ'}
      </span>

    </button>
  )
}
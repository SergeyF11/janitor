import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { generateDeviceToken, getDeviceStatus } from '../api'

export default function DeviceToken({ groupId }) {
  const [device, setDevice] = useState(null)
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [showQR, setShowQR] = useState(false)

  useEffect(() => {
    loadDevice()
  }, [groupId])

  const loadDevice = async () => {
    setLoading(true)
    try {
      const res = await getDeviceStatus(groupId)
      setDevice(res.data)
      if (res.data.pending_code) {
        setToken({
          code: res.data.pending_code,
          expires_at: res.data.code_expires_at
        })
      }
    } catch (err) {
      console.log('Ошибка загрузки устройства')
    } finally {
      setLoading(false)
    }
  }

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      const res = await generateDeviceToken(groupId)
      setToken(res.data)
      setShowQR(true)
    } catch (err) {
      console.log('Ошибка генерации кода')
    } finally {
      setGenerating(false)
    }
  }

  const formatExpiry = (ts) => {
    const d = new Date(ts)
    return d.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
  }

  if (loading) return <p style={{ color: '#aaa', fontSize: '13px' }}>Загрузка...</p>

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>📡 Устройство ESP</h3>

      {/* Статус устройства */}
      {device?.device_id ? (
        <div style={styles.deviceInfo}>
          <span style={device.is_online ? styles.online : styles.offline}>
            {device.is_online ? '✅ Онлайн' : '⚫ Оффлайн'}
          </span>
          <span style={styles.deviceId}>{device.device_id}</span>
          {device.last_seen && (
            <span style={styles.lastSeen}>
              {device.is_online ? 'Подключено' : 'Последний раз'}: {formatExpiry(device.last_seen)}
            </span>
          )}
        </div>
      ) : (
        <p style={styles.noDevice}>Устройство не подключено</p>
      )}

      {/* Кнопка генерации кода */}
      <button
        style={styles.generateBtn}
        onClick={handleGenerate}
        disabled={generating}
      >
        {generating ? '⏳ Генерация...' :
         token ? '🔄 Перевыпустить код' : '🔗 Сгенерировать код привязки'}
      </button>

      {/* Предупреждение при перевыпуске */}
      {token && !showQR && (
        <p style={styles.warning}>
          ⚠️ Перевыпуск аннулирует старый код и потребует перенастройки устройства
        </p>
      )}

      {/* Показать QR и код */}
      {token && showQR && (
        <div style={styles.qrContainer}>
          <div style={styles.qrWrapper}>
            <QRCodeSVG
              value={token.code}
              size={180}
              bgColor="#ffffff"
              fgColor="#0f3460"
              level="M"
            />
          </div>
          <div style={styles.codeDisplay}>
            {token.code.split('').map((digit, i) => (
              <span key={i} style={styles.digit}>{digit}</span>
            ))}
          </div>
          <p style={styles.expiry}>
            Действителен до: {formatExpiry(token.expires_at)}
          </p>
          <button style={styles.hideBtn} onClick={() => setShowQR(false)}>
            Скрыть
          </button>
        </div>
      )}

      {token && !showQR && (
        <button style={styles.showBtn} onClick={() => setShowQR(true)}>
          Показать код
        </button>
      )}
    </div>
  )
}

const styles = {
  container: {
    background: '#0a2440',
    borderRadius: '12px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    marginTop: '8px',
  },
  title: {
    fontSize: '15px',
    fontWeight: 'bold',
    color: '#eee',
  },
  deviceInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  online: { fontSize: '13px', color: '#27ae60' },
  deviceId: { fontSize: '12px', color: '#aaa', fontFamily: 'monospace' },
  lastSeen: { fontSize: '12px', color: '#888' },
  noDevice: { fontSize: '13px', color: '#888' },
  generateBtn: {
    background: '#1a4a7a',
    color: 'white',
    padding: '10px',
    borderRadius: '8px',
    fontSize: '14px',
  },
  warning: {
    fontSize: '12px',
    color: '#ffcc80',
    lineHeight: 1.4,
  },
  qrContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    padding: '16px',
    background: '#16213e',
    borderRadius: '12px',
  },
  qrWrapper: {
    background: 'white',
    padding: '12px',
    borderRadius: '8px',
  },
  codeDisplay: {
    display: 'flex',
    gap: '8px',
  },
  digit: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '44px',
    background: '#0f3460',
    borderRadius: '8px',
    fontSize: '24px',
    fontWeight: 'bold',
    color: '#e94560',
    fontFamily: 'monospace',
  },
  expiry: {
    fontSize: '12px',
    color: '#aaa',
  },
  hideBtn: {
    background: 'transparent',
    color: '#aaa',
    fontSize: '13px',
    padding: '4px 12px',
    border: '1px solid #333',
    borderRadius: '6px',
  },
  showBtn: {
    background: '#1a4a7a',
    color: 'white',
    padding: '8px',
    borderRadius: '8px',
    fontSize: '13px',
  },
  offline: { fontSize: '13px', color: '#888' },
}
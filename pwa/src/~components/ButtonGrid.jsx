import RelayButton from './RelayButton'

export default function ButtonGrid({ groups, onStateChange }) {
  const count = groups.length

  // Стили сетки в зависимости от количества кнопок
  const getGridStyle = () => {
    if (count === 1) return {
      display: 'grid',
      gridTemplateColumns: '1fr',
      gridTemplateRows: '1fr',
    }
    if (count === 2) return {
      display: 'grid',
      gridTemplateColumns: '1fr',
      gridTemplateRows: '1fr 1fr',
    }
    return {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridAutoRows: '1fr',
    }
  }

  return (
    <div style={{
      ...getGridStyle(),
      gap: '12px',
      padding: '12px',
      height: '100%',
      width: '100%',
    }}>
      {groups.map((group, index) => {
        // Последняя кнопка при нечётном количестве (3,5,7,9)
        // растягивается на всю ширину
        const isLast = index === count - 1
        const isOdd = count % 2 !== 0
        const spanFull = isLast && isOdd && count > 2

        return (
          <div
            key={group.id}
            style={{
              gridColumn: spanFull ? '1 / -1' : 'auto',
              minHeight: '80px',
            }}
          >
            <RelayButton
              group={group}
              onStateChange={onStateChange}
            />
          </div>
        )
      })}
    </div>
  )
}
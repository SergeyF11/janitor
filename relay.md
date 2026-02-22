## Доработка: режимы работы реле

### Два режима одной кнопки

```
duration > 0  →  ИМПУЛЬСНЫЙ режим   (кратковременное замыкание)
duration = 0  →  ТРИГГЕРНЫЙ режим   (вкл/выкл, фиксация состояния)
```

---

### Изменения в модели данных

```sql
-- таблица groups — добавить поля:
ALTER TABLE groups ADD COLUMN relay_duration_ms INTEGER NOT NULL DEFAULT 500;
-- 0 = триггерный режим, >0 = длительность импульса в мс

ALTER TABLE groups ADD COLUMN relay_state BOOLEAN NOT NULL DEFAULT FALSE;
-- текущее состояние (актуально только для триггерного режима)
```

---

### MQTT команды

#### Импульсный режим (duration > 0)
```json
// сервер → устройство
relay/{groupId}/trigger
{"action": "pulse", "duration": 750, "user_id": "uuid", "ts": 1234567890}

// устройство → сервер (подтверждение)
relay/{groupId}/status
{"state": "pulse", "duration": 750, "device_id": "AA:BB:CC", "ts": ...}
```

#### Триггерный режим (duration = 0)
```json
// сервер → устройство
relay/{groupId}/trigger
{"action": "toggle", "user_id": "uuid", "ts": 1234567890}

// устройство → сервер
relay/{groupId}/status
{"state": "on", "device_id": "AA:BB:CC", "ts": ...}
// или
{"state": "off", "device_id": "AA:BB:CC", "ts": ...}
```

Состояние `relay/{groupId}/status` публикуется с флагом **retained=true**, чтобы новые подписчики (PWA) сразу получали актуальное состояние реле.

---

### Логика на сервере

```
POST /api/user/groups/:id/trigger

  → получить группу из БД (relay_duration_ms, relay_state)

  если duration > 0:
    → MQTT publish: {action:"pulse", duration}
    → записать в лог: "pulse 750ms"

  если duration = 0:
    → новое состояние = !relay_state
    → UPDATE groups SET relay_state = новое состояние
    → MQTT publish: {action:"toggle"}
    → записать в лог: "toggle → ON" / "toggle → OFF"

  → вернуть {mode, state, duration}
```

---

### Логика на ESP

```cpp
// ──── Обработчик входящего MQTT сообщения ────

void onMessage(char* topic, byte* payload, unsigned int len) {
  DynamicJsonDocument doc(256);
  deserializeJson(doc, payload, len);
  const char* action = doc["action"];

  if (strcmp(action, "pulse") == 0) {
    // ИМПУЛЬСНЫЙ РЕЖИМ
    int dur = doc["duration"] | 500;
    digitalWrite(RELAY_PIN, RELAY_ON);
    ledPulse();                        // 2 быстрые вспышки
    delay(dur);                        // держим реле
    digitalWrite(RELAY_PIN, RELAY_OFF);
    publishStatus("pulse");

  } else if (strcmp(action, "toggle") == 0) {
    // ТРИГГЕРНЫЙ РЕЖИМ
    relayState = !relayState;
    digitalWrite(RELAY_PIN, relayState ? RELAY_ON : RELAY_OFF);
    ledToggle(relayState);             // горит = вкл, гаснет = выкл
    publishStatus(relayState ? "on" : "off");
  }
}

// При подключении к MQTT — восстановить состояние из retained топика
void onMqttConnect() {
  client.subscribe("relay/{groupId}/status");  // получим retained
  // когда придёт retained сообщение — восстановим relayState
  // и установим физическое состояние реле
}
```

---

### Настройки в CaptivePortal

```
НАСТРОЙКИ КАНАЛА 1
  Название:    [Ворота          ]
  Длительность реле:
    ( ) Импульс  [_750_] мс
    ( ) Вкл/Выкл

НАСТРОЙКИ КАНАЛА 2  (если 2 реле)
  Название:    [Калитка         ]
  Длительность реле:
    ( ) Импульс  [_500_] мс
    (●) Вкл/Выкл
```

Значение сохраняется в `settings.json`:
```json
{
  "group1_id": "abc-123",
  "group1_duration": 750,
  "group2_id": "def-456",
  "group2_duration": 0
}
```

---

### Отображение кнопки в PWA

#### Импульсный режим
```
┌──────────────────────────────┐
│                              │
│          ВОРОТА              │  ← нейтральный цвет всегда
│        ⚡ 0.75с              │  ← иконка + длительность
│                              │
└──────────────────────────────┘
  При нажатии: кратковременная анимация нажатия → возврат
```

#### Триггерный режим
```
  ВЫКЛЮЧЕНО                      ВКЛЮЧЕНО
┌──────────────────────────────┐  ┌──────────────────────────────┐
│                              │  │                              │
│          КАЛИТКА             │  │          КАЛИТКА             │
│           ○ ВЫКЛ             │  │           ● ВКЛ              │
│                              │  │                              │
└──────────────────────────────┘  └──────────────────────────────┘
  серый / тёмный фон               зелёный фон, активное состояние
```

---

### Индикация LED на устройстве — дополнение

| Режим | Индикация |
|-------|-----------|
| Импульс выполняется | 2 быстрые вспышки во время импульса |
| Триггер → ВКЛ | Постоянное свечение |
| Триггер → ВЫКЛ | Редкое мигание 3с (штатный heartbeat) |

Постоянное свечение при триггере ВКЛ даёт визуальный контроль состояния реле прямо на устройстве без подключения к приложению.

---

### Восстановление состояния после перезагрузки устройства

Поскольку retained MQTT сообщение хранит последнее состояние, при перезагрузке ESP:

```
1. Подключиться к MQTT
2. Подписаться на relay/{groupId}/status
3. Получить retained → восстановить relayState в RAM
4. Установить физическое состояние реле digitalWrite(...)
5. Только после этого → перейти в рабочий режим
```

Это гарантирует, что реле в триггерном режиме восстановит своё состояние после любого сбоя питания.
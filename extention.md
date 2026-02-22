## ПЛАН РАСШИРЕНИЯ: SIM800L + Голосовые ассистенты

---

## ЧАСТЬ 1: МОДУЛЬ SIM800L

### 1.1 Аппаратная часть

```
ESP32 ←→ SIM800L
  UART2 TX (GPIO17) → RX SIM800L
  UART2 RX (GPIO16) ← TX SIM800L
  GPIO4             → RST SIM800L (программный сброс)
  
  Питание SIM800L: 3.7–4.2В / до 2А пиковые (отдельный источник!)
  Не питать от 3.3В ESP — просадка вызовет сбросы
```

```
┌─────────────────────────────────────────────────────┐
│                    ESP32                            │
│                                                     │
│  UART2 ◄──────────────────────► SIM800L             │
│  GPIO4 ──── RST                  │                  │
│                               SIM-карта             │
│                            (голосовой тариф         │
│                             или только данные)      │
└─────────────────────────────────────────────────────┘
```

---

### 1.2 Расширение модели данных

```sql
-- Телефонные книги устройств
CREATE TABLE device_phonebooks (
  id            UUID PRIMARY KEY,
  device_id     UUID REFERENCES devices(id),
  phone         VARCHAR(20) NOT NULL,    -- +79001234567
  label         VARCHAR(100),            -- "Иван Петров"
  call_action   VARCHAR(20),             -- 'toggle'|'pulse'|'ignore'
  sms_enabled   BOOLEAN DEFAULT TRUE,
  sms_keywords  JSONB,                   -- {"on":["включи","открой"],"off":["выключи"]}
  relay_target  INTEGER DEFAULT 1,       -- 1 или 2 (какое реле)
  created_by    UUID REFERENCES users(id),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Журнал звонков/SMS
CREATE TABLE phone_events (
  id            UUID PRIMARY KEY,
  device_id     UUID REFERENCES devices(id),
  phone         VARCHAR(20),
  event_type    VARCHAR(10),             -- 'call'|'sms'
  sms_text      TEXT,
  action_taken  VARCHAR(20),             -- 'toggle'|'pulse'|'rejected'
  relay_target  INTEGER,
  ts            TIMESTAMPTZ DEFAULT NOW()
);

-- Версия фонбука для инкрементальной синхронизации
CREATE TABLE device_phonebook_version (
  device_id     UUID PRIMARY KEY REFERENCES devices(id),
  version       INTEGER DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

---

### 1.3 MQTT топики для SIM800L

```
── Синхронизация фонбука ──────────────────────────────────────
devices/{deviceId}/phonebook/full      ← сервер → устройство
devices/{deviceId}/phonebook/patch     ← сервер → устройство
devices/{deviceId}/phonebook/version   → устройство → сервер (при подключении)

── События с устройства ───────────────────────────────────────
devices/{deviceId}/phone/event         → звонок/смс получен
devices/{deviceId}/phone/report        → отчёт о выполнении команды

── Управление модемом ─────────────────────────────────────────
devices/{deviceId}/sim/status          → RSSI, оператор, баланс
devices/{deviceId}/sim/command         ← перезагрузить модем, etc.
```

#### Формат фонбука (full sync)
```json
{
  "version": 42,
  "phones": [
    {
      "phone": "+79001234567",
      "label": "Иван",
      "call_action": "toggle",
      "sms_enabled": true,
      "sms_keywords": {
        "on":  ["включи", "открой", "on"],
        "off": ["выключи", "закрой", "off"]
      },
      "relay_target": 1
    },
    {
      "phone": "+79009876543",
      "label": "Охрана",
      "call_action": "pulse",
      "sms_enabled": false,
      "relay_target": 2
    }
  ]
}
```

#### Формат патча (при добавлении/изменении одного номера)
```json
{
  "version": 43,
  "op": "upsert",
  "phone": {
    "phone": "+79001111111",
    "label": "Новый",
    "call_action": "toggle",
    "relay_target": 1
  }
}
```
```json
{
  "version": 44,
  "op": "delete",
  "phone": "+79001111111"
}
```

---

### 1.4 Логика синхронизации

```
При подключении устройства к MQTT:
  → publish devices/{deviceId}/phonebook/version {"version": 38}

Сервер получает версию:
  если версия совпадает → не отправлять ничего
  если версия устарела  → publish phonebook/full с актуальными данными

При добавлении/удалении номера администратором:
  → version++ в БД
  если устройство online → publish phonebook/patch немедленно
  если offline → при следующем подключении получит full sync

Устройство при получении full/patch:
  → обновить RAM-фонбук
  → сохранить в LittleFS /phonebook.json
  → publish подтверждение {"version": 43, "count": 15}
```

---

### 1.5 Скетч ESP32 — модуль SIM800L

```cpp
// ──── sim800l.h ────────────────────────────────────

#include <HardwareSerial.h>

#define SIM_RX    16
#define SIM_TX    17
#define SIM_RST   4
#define SIM_BAUD  9600

HardwareSerial simSerial(2);

// Состояния автомата SIM800L
enum SimState {
  SIM_IDLE,
  SIM_INCOMING_CALL,
  SIM_CALL_HANDLED,
  SIM_SMS_RECEIVED,
  SIM_ERROR
};

struct PhoneEntry {
  String phone;
  String label;
  String callAction;   // "toggle"|"pulse"|"ignore"
  bool   smsEnabled;
  int    relayTarget;
  // keywords хранятся отдельно в phonebook.json
};

// ──── Обработка входящего звонка ────
void onIncomingCall(String phone) {
  PhoneEntry* entry = findPhone(phone);

  if (!entry) {
    // Неизвестный номер
    simSendAT("ATH");  // сбросить звонок
    publishPhoneEvent(phone, "call", "", "rejected");
    return;
  }

  simSendAT("ATH");    // всегда сбрасываем (не поднимаем трубку)

  executeRelayCommand(entry->callAction, entry->relayTarget);

  // Отчёт по MQTT
  publishPhoneReport(phone, "call", entry->callAction, entry->relayTarget);
}

// ──── Обработка входящего SMS ────
void onIncomingSMS(String phone, String text) {
  PhoneEntry* entry = findPhone(phone);

  if (!entry || !entry->smsEnabled) {
    publishPhoneEvent(phone, "sms", text, "rejected");
    return;
  }

  // Парсим ключевые слова из phonebook.json
  String action = parseKeywords(phone, text);  // "on"|"off"|"unknown"

  if (action == "on") {
    executeRelayOn(entry->relayTarget);
    publishPhoneReport(phone, "sms", "on", entry->relayTarget);
  } else if (action == "off") {
    executeRelayOff(entry->relayTarget);
    publishPhoneReport(phone, "sms", "off", entry->relayTarget);
  } else {
    publishPhoneReport(phone, "sms", "unknown_keyword", entry->relayTarget);
  }
}
```

---

### 1.6 Индикация LED — дополнение для SIM800L

| Ситуация | Индикация |
|----------|-----------|
| Модем инициализируется | 4 вспышки подряд |
| Нет SIM / нет сети | Двойное мигание каждые 2с |
| Команда выполнена по звонку | 3 вспышки |
| SMS обработан | 2 длинные вспышки |
| Неизвестный номер | Одиночная короткая вспышка |

---

### 1.7 Интерфейс в PWA — вкладка Администрирование

```
┌─────────────────────────────────────────┐
│  [Пользователи]  [Телефоны]  [Журнал]  │
└─────────────────────────────────────────┘

── Вкладка ТЕЛЕФОНЫ ──────────────────────
┌─────────────────────────────────────────┐
│  + Добавить номер                       │
├─────────────────────────────────────────┤
│ Иван Петров                             │
│ +79001234567                            │
│ Звонок: Вкл/Выкл  Реле: 1             │
│ SMS: ✓  Ключевые слова: [редактировать]│
│                            [✏️] [🗑️]  │
├─────────────────────────────────────────┤
│ Охрана                                  │
│ +79009876543                            │
│ Звонок: Импульс   Реле: 2             │
│ SMS: ✗                                 │
│                            [✏️] [🗑️]  │
└─────────────────────────────────────────┘

── Форма добавления/редактирования ───────
┌─────────────────────────────────────────┐
│ Номер:   [+79001234567    ]             │
│ Имя:     [Иван Петров     ]            │
│ Реле:    (●) 1  ( ) 2                  │
│                                         │
│ По звонку:                              │
│   (●) Вкл/Выкл  ( ) Импульс  ( ) Нет  │
│                                         │
│ По SMS: [✓] разрешить                  │
│ Слова ВКЛ:  [включи, открой, on  ]     │
│ Слова ВЫКЛ: [выключи, закрой, off]     │
│                                         │
│      [Отмена]        [Сохранить]        │
└─────────────────────────────────────────┘
```

---

---

## ЧАСТЬ 2: ГОЛОСОВЫЕ АССИСТЕНТЫ

### 2.1 Архитектура интеграции

```
┌──────────────┐     Webhook/     ┌─────────────────┐
│    Алиса     │ ────────────► │                 │
│    Маруся    │     HTTPS        │  Backend        │
│    Салют     │ ◄──────────── │  /api/voice/    │
└──────────────┘   JSON ответ    │  {assistant}    │
                                  │       │         │
                                  │       ▼         │
                                  │  MQTT publish   │
                                  │  relay/trigger  │
                                  └─────────────────┘
```

Все три ассистента работают по одной схеме: **OAuth 2.0** для авторизации + **Webhook** для обработки команд.

---

### 2.2 Расширение модели данных

```sql
-- OAuth токены ассистентов
CREATE TABLE voice_assistant_tokens (
  id              UUID PRIMARY KEY,
  user_id         UUID REFERENCES users(id),
  assistant       VARCHAR(20),     -- 'alice'|'marusia'|'salut'
  access_token    TEXT,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ,
  linked_groups   UUID[],          -- к каким группам привязан
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Маппинг голосовых имён → группы
CREATE TABLE voice_channel_names (
  id          UUID PRIMARY KEY,
  group_id    UUID REFERENCES groups(id),
  assistant   VARCHAR(20),
  voice_name  VARCHAR(100),   -- "ворота", "калитка", "гараж"
  UNIQUE(group_id, assistant)
);
```

---

### 2.3 Алиса (Яндекс)

**Схема подключения:**
```
Яндекс Диалоги → создать навык типа "Умный дом"
  └── OAuth: наш сервер /api/oauth/alice/...
  └── Webhook: /api/voice/alice/webhook
```

**Формат webhook запроса от Алисы:**
```json
{
  "session": { "user": { "user_id": "yandex_user_id" } },
  "request": {
    "command": "включи ворота",
    "nlu": {
      "intents": {
        "turn_on":  { "slots": { "what": { "value": "ворота" } } },
        "turn_off": { "slots": { "what": { "value": "ворота" } } }
      }
    }
  }
}
```

**Обработчик:**
```
/api/voice/alice/webhook
  → найти user по yandex_user_id (через OAuth токен)
  → извлечь intent: turn_on / turn_off / pulse
  → найти группу по voice_name ("ворота")
  → проверить права пользователя на группу
  → записать в event_log (источник: "alice")
  → MQTT publish relay/{groupId}/trigger
  → вернуть Алисе ответ: "Хорошо, ворота открываю"
```

**Поддерживаемые команды:**
```
"включи [название]"    → toggle ON  / pulse
"выключи [название]"   → toggle OFF
"открой [название]"    → toggle ON  / pulse
"закрой [название]"    → toggle OFF
"сработай [название]"  → pulse
```

---

### 2.4 Маруся (VK) и Салют (Сбер)

Архитектура идентична Алисе, различаются только:

| | Алиса | Маруся | Салют |
|---|---|---|---|
| Платформа | Яндекс Диалоги | VK Mini Apps | Сбер SmartApp |
| OAuth | Яндекс OAuth | VK Connect | Сбер ID |
| Webhook | `/api/voice/alice` | `/api/voice/marusia` | `/api/voice/salut` |
| SDK | `@yandex/dialogs` | `@vkontakte/vk-bridge` | SmartApp API |
| Протокол | HTTPS JSON | HTTPS JSON | HTTPS JSON |

Общий обработчик на сервере:

```
/api/voice/{assistant}/webhook
  → нормализовать запрос в единый формат VoiceCommand
  → единая бизнес-логика (маппинг → MQTT)
  → формат ответа специфичен для каждого ассистента
```

```typescript
// Единый интерфейс для всех ассистентов
interface VoiceCommand {
  assistantUserId: string;   // внешний ID у ассистента
  assistant: 'alice' | 'marusia' | 'salut';
  intent: 'on' | 'off' | 'pulse' | 'status';
  channelName: string;       // "ворота"
  rawText: string;
}
```

---

### 2.5 Настройка голосовых ассистентов в PWA

```
── Вкладка Администрирование → Голосовые ассистенты ──

┌──────────────────────────────────────────────────────┐
│  🎙️ Голосовые ассистенты                            │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Алиса (Яндекс)          [Подключить] / [✓ Активна] │
│  Маруся (VK)             [Подключить]                │
│  Салют (Сбер)            [Подключить]                │
│                                                      │
├──────────────────────────────────────────────────────┤
│  Голосовые имена каналов:                           │
│                                                      │
│  Канал 1 "Ворота"                                   │
│    Алиса:  [ворота, гараж        ]                  │
│    Маруся: [ворота               ]                  │
│    Салют:  [ворота, въезд        ]                  │
│                                                      │
│  Канал 2 "Калитка"                                  │
│    Алиса:  [калитка, дверь       ]                  │
│    Маруся: [калитка              ]                  │
│    Салют:  [калитка              ]                  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

### 2.6 Журнал событий — расширение

```
Все источники команд логируются единообразно:

event_log.source: 'pwa' | 'call' | 'sms' | 'alice' | 'marusia' | 'salut'

── Журнал группы (в PWA) ──────────────────────────

14:32  Иван П.  [PWA]    Ворота → импульс 750мс
14:15  +79001…  [SMS]    Ворота → ВКЛ ("открой")
13:58  Алиса            Ворота → импульс ("открой гараж")
13:45  +79001…  [Звонок] Ворота → импульс
13:30  Иван П.  [Маруся] Калитка → ВЫКЛ
```

---

## ИТОГОВАЯ СХЕМА РАСШИРЕННОЙ АРХИТЕКТУРЫ

```
                    ┌─────────────────────────────────┐
                    │         ИСТОЧНИКИ КОМАНД         │
                    │                                  │
   Смартфон ───────►│  PWA-приложение                 │
   Алиса ──────────►│  Яндекс Webhook                 │
   Маруся ─────────►│  VK Webhook          Backend    │
   Салют ──────────►│  Сбер Webhook                   │
   Звонок ─────────►│  SIM800L → ESP32 → MQTT ────────┼──►  реле
   SMS ────────────►│  SIM800L → ESP32 → MQTT         │
                    └─────────────────────────────────┘
                              │
                         event_log
                    (источник всегда известен)
```

---

## ПОРЯДОК РЕАЛИЗАЦИИ РАСШИРЕНИЙ

**Этап A — SIM800L** (после основной системы)
1. Схема подключения + базовый AT-драйвер
2. MQTT топик фонбука + синхронизация
3. Обработка звонков
4. Обработка SMS с ключевыми словами
5. UI в PWA (вкладка Телефоны)

**Этап Б — Голосовые ассистенты**
1. OAuth сервер (единый для всех)
2. Алиса (наиболее документированная)
3. Маруся
4. Салют
5. UI настройки голосовых имён в PWA

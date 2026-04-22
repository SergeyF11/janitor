#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

#include "config.h"
#include "phone_db.h"
#include "sms_journal.h"
#include "relay.h"

// ── Пины TTGO T-Call ─────────────────────────────────────────
// #ifndef MODEM_RX
//   #define MODEM_RX        26
// #endif
// #ifndef MODEM_TX
//   #define MODEM_TX        27
// #endif
// #ifndef MODEM_PWRKEY
//   #define MODEM_PWRKEY     4
// #endif
// #ifndef MODEM_POWER_ON
//   #define MODEM_POWER_ON  23
// #endif
// #ifndef MODEM_RST
//   #define MODEM_RST        5
// #endif

// // PMU IP5306 (I2C)
// #ifndef PMU_SDA
//   #define PMU_SDA         21
// #endif
// #ifndef PMU_SCL
//   #define PMU_SCL         22
// #endif

// #define SERIAL_MODEM      Serial1
// #define MODEM_BAUD        115200

// ── FreeRTOS параметры ────────────────────────────────────────
#define GSM_TASK_STACK    4096
#define GSM_TASK_PRIORITY 5
#define GSM_TASK_CORE     0       // GSM на core 0, MQTT/WiFi на core 1

#define GSM_QUEUE_SIZE    8       // размер очереди команд → реле

// ── Команда от GSM к основному циклу ─────────────────────────
enum class GsmCmdType : uint8_t {
    RELAY_TRIGGER,    // сработать реле по звонку/SMS
    MQTT_PUBLISH,     // опубликовать событие через MQTT
    SMS_SEND,         // отправить SMS (ответ на операторское)
};

struct GsmRelayCmd {
    uint8_t  relayMask;   // битовая маска реле
    uint32_t durationMs;  // 0 = toggle/on, >0 = pulse
    uint16_t idx;         // idx из phoneDb (для журнала)
    char     source[4];   // "sms" или "call"
};

struct GsmSmsCmd {
    char number[SMSJ_NUMBER_LEN];
    char text[SMSJ_TEXT_LEN];
};

struct GsmMqttEvent {
    char     payload[192];  // JSON для публикации
};

struct GsmCommand {
    GsmCmdType type;
    union {
        GsmRelayCmd relay;
        GsmSmsCmd   sms;
        GsmMqttEvent mqtt;
    };
};

// ── Статус GSM для MQTT heartbeat ─────────────────────────────
struct GsmStatus {
    bool     initialized;
    bool     simReady;
    bool     networkConnected;
    int8_t   signalBars;       // 0..4
    char     operatorName[32];
    bool     callInProgress;
    uint16_t unreadSms;        // из SmsLog
};

// ── Менеджер GSM ──────────────────────────────────────────────
class GsmManager {
public:
    // Инициализация — вызывать в setup() до startTask()
    bool begin(DeviceConfig& cfg);

    // Запуск FreeRTOS задачи
    void startTask();

    // Очередь команд от GSM → main loop
    // Вызывать в loop() для обработки
    bool dequeueCommand(GsmCommand& cmd);

    // Команды от MQTT → GSM (thread-safe)
    // Отправить SMS (ответ на операторский)
    bool sendSms(const char* number, const char* text);

    // Запросить статус (ответ через MQTT_PUBLISH в очереди)
    void requestStatus();

    // Получить текущий статус (без блокировки)
    GsmStatus getStatus();

    // Компактификация БД (запустить из loop)
    void triggerCompaction() { _needCompaction = true; }
    bool isCompacting() const { return PhoneBook.isCompactionInProgress(); }

    // Мьютекс для доступа к phoneDb из разных задач
    SemaphoreHandle_t dbMutex = nullptr;

private:
    DeviceConfig*  _cfg         = nullptr;
    TaskHandle_t   _taskHandle  = nullptr;
    QueueHandle_t  _cmdQueue    = nullptr;   // GsmCommand → main loop
    QueueHandle_t  _smsQueue    = nullptr;   // GsmSmsCmd  → gsm task
    SemaphoreHandle_t _statusMutex = nullptr;
    GsmStatus      _status      = {};
    bool           _needCompaction = false;

    // ── GSM task ──────────────────────────────────────────────
    static void _gsmTask(void* pvParam);
    void        _taskLoop();
    static uint64_t _normalizePhone(const char* raw);
    
    // ── Инициализация модема (как в JarvisAsync) ──────────────
    bool _initModem();

    // ── Обработчики событий модема ────────────────────────────
    void _onIncomingCall(const String& number);
    void _onIncomingSms (const String& number, const String& text);

    // ── Разбор SMS команды ────────────────────────────────────
    // Возвращает битовую маску реле из текста SMS
    // Формат: "0", "1", "2"... (индекс реле) или имя реле
    uint8_t _parseSmsCommand(const String& text, uint16_t relayCount);

    // ── Публикация события в MQTT (через очередь) ─────────────
    void _publishEvent(const char* source, uint16_t idx,
                       const char* action, uint8_t relayMask);
    void _publishUnknown(const char* source, const char* number,
                         const char* text = nullptr);

    // ── Обновление статуса (под мьютексом) ───────────────────
    void _updateStatus();

    // ── Отправка в очередь команд ─────────────────────────────
    bool _enqueueRelay(uint8_t mask, uint32_t durationMs,
                       uint16_t idx, const char* source);
    bool _enqueueMqtt(const char* json);
    bool _enqueueSms(const char* number, const char* text);
};

extern GsmManager GsmMgr;
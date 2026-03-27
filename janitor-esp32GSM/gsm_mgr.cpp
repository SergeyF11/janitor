#include "gsm_mgr.h"
#include <SIM800_Modem_b.h>
#include <time.h>

// ── Глобальные объекты ────────────────────────────────────────
GsmManager GsmMgr;

// Модем — единственный экземпляр, доступен из task-файлов через extern
GSMModem modem(SERIAL_MODEM,
               MODEM_POWER_ON,
               MODEM_RST,
               MODEM_PWRKEY);

PMU_IP5306 pmu(PMU_SDA, PMU_SCL);

// ─────────────────────────────────────────────────────────────
//  begin()
// ─────────────────────────────────────────────────────────────
bool GsmManager::begin(DeviceConfig& cfg) {
    _cfg = &cfg;

    dbMutex      = xSemaphoreCreateMutex();
    _statusMutex = xSemaphoreCreateMutex();
    if (!dbMutex || !_statusMutex) return false;

    _cmdQueue = xQueueCreate(GSM_QUEUE_SIZE, sizeof(GsmCommand));
    _smsQueue = xQueueCreate(4,             sizeof(GsmSmsCmd));
    if (!_cmdQueue || !_smsQueue) return false;

    pmu.begin();

    SERIAL_MODEM.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX, MODEM_TX);
    delay(100);

    modem.setPMUManager(&pmu);

    modem.setIncomingCallHandler([](const String& number) {
        GsmMgr._onIncomingCall(number);
    });
    modem.setIncomingSMSHandler([](const String& number, const String& text) {
        GsmMgr._onIncomingSms(number, text);
    });
    modem.setTimeSyncHandler([](time_t ts, int tzOffset) {
        if (time(nullptr) < 1700000000UL) {
            struct timeval tv = { ts, 0 };
            settimeofday(&tv, nullptr);
            log_i("[GSM] Time synced from GSM: %lu", (unsigned long)ts);
        }
    });

    modem.autoSyncTimeFromGSM(true);
    modem.setPDUMode();

    log_i("[GSM] Manager initialized");
    return true;
}

// ─────────────────────────────────────────────────────────────
//  startTask()
// ─────────────────────────────────────────────────────────────
void GsmManager::startTask() {
    xTaskCreatePinnedToCore(
        _gsmTask,
        "gsm_task",
        GSM_TASK_STACK,
        this,
        GSM_TASK_PRIORITY,
        &_taskHandle,
        GSM_TASK_CORE
    );
    log_i("[GSM] Task started on core %d", GSM_TASK_CORE);
}

// ─────────────────────────────────────────────────────────────
//  Публичные методы (thread-safe, вызываются из core 1)
// ─────────────────────────────────────────────────────────────
bool GsmManager::dequeueCommand(GsmCommand& cmd) {
    return xQueueReceive(_cmdQueue, &cmd, 0) == pdTRUE;
}

bool GsmManager::sendSms(const char* number, const char* text) {
    GsmSmsCmd cmd;
    strncpy(cmd.number, number, sizeof(cmd.number) - 1);
    strncpy(cmd.text,   text,   sizeof(cmd.text)   - 1);
    cmd.number[sizeof(cmd.number) - 1] = '\0';
    cmd.text[sizeof(cmd.text)   - 1]   = '\0';
    return xQueueSend(_smsQueue, &cmd, pdMS_TO_TICKS(100)) == pdTRUE;
}

void GsmManager::requestStatus() {
    GsmStatus s = getStatus();
    char json[256];
    snprintf(json, sizeof(json),
        "{\"type\":\"gsm_status\","
        "\"sim\":%s,\"net\":%s,"
        "\"signal\":%d,\"operator\":\"%s\","
        "\"call\":%s,\"unread_sms\":%u}",
        s.simReady         ? "true" : "false",
        s.networkConnected ? "true" : "false",
        s.signalBars,
        s.operatorName,
        s.callInProgress   ? "true" : "false",
        s.unreadSms
    );
    _enqueueMqtt(json);
}

GsmStatus GsmManager::getStatus() {
    GsmStatus s = {};
    if (xSemaphoreTake(_statusMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        s = _status;
        xSemaphoreGive(_statusMutex);
    }
    return s;
}

// ─────────────────────────────────────────────────────────────
//  Внутренние методы очереди
// ─────────────────────────────────────────────────────────────
bool GsmManager::_enqueueRelay(uint8_t mask, uint32_t durationMs,
                                uint16_t idx, const char* source) {
    GsmCommand cmd;
    cmd.type             = GsmCmdType::RELAY_TRIGGER;
    cmd.relay.relayMask  = mask;
    cmd.relay.durationMs = durationMs;
    cmd.relay.idx        = idx;
    strncpy(cmd.relay.source, source, sizeof(cmd.relay.source) - 1);
    cmd.relay.source[sizeof(cmd.relay.source) - 1] = '\0';
    return xQueueSend(_cmdQueue, &cmd, pdMS_TO_TICKS(100)) == pdTRUE;
}

bool GsmManager::_enqueueMqtt(const char* json) {
    GsmCommand cmd;
    cmd.type = GsmCmdType::MQTT_PUBLISH;
    strncpy(cmd.mqtt.payload, json, sizeof(cmd.mqtt.payload) - 1);
    cmd.mqtt.payload[sizeof(cmd.mqtt.payload) - 1] = '\0';
    return xQueueSend(_cmdQueue, &cmd, pdMS_TO_TICKS(100)) == pdTRUE;
}

bool GsmManager::_enqueueSms(const char* number, const char* text) {
    GsmCommand cmd;
    cmd.type = GsmCmdType::SMS_SEND;
    strncpy(cmd.sms.number, number, sizeof(cmd.sms.number) - 1);
    strncpy(cmd.sms.text,   text,   sizeof(cmd.sms.text)   - 1);
    cmd.sms.number[sizeof(cmd.sms.number) - 1] = '\0';
    cmd.sms.text[sizeof(cmd.sms.text)     - 1] = '\0';
    return xQueueSend(_cmdQueue, &cmd, pdMS_TO_TICKS(100)) == pdTRUE;
}

// ─────────────────────────────────────────────────────────────
//  _updateStatus()  — под мьютексом, вызывается из GSM task
// ─────────────────────────────────────────────────────────────
void GsmManager::_updateStatus() {
    if (xSemaphoreTake(_statusMutex, pdMS_TO_TICKS(50)) != pdTRUE) return;

    _status.initialized      = modem.isInitialized();
    _status.simReady         = modem.isSimReady();
    _status.networkConnected = modem.isNetworkConnected();
    _status.callInProgress   = modem.isCallInProgress();
    _status.unreadSms        = SmsLog.unreadCount();

    // signalBars из строки "▂▄▆█" — берём число баров через кол-во не-ASCII символов
    const char* bars = modem.getSignalBars();
    _status.signalBars = bars ? (int8_t)strlen(bars) : 0;

    const char* op = modem.getOperator();
    strncpy(_status.operatorName, op ? op : "",
            sizeof(_status.operatorName) - 1);
    _status.operatorName[sizeof(_status.operatorName) - 1] = '\0';

    xSemaphoreGive(_statusMutex);
}

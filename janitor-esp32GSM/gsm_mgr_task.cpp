#include "gsm_mgr.h"
#include <SIM800_Modem_b.h>

extern GSMModem modem;
extern PMU_IP5306 pmu;

// ─────────────────────────────────────────────────────────────
//  FreeRTOS task entry point
// ─────────────────────────────────────────────────────────────
void GsmManager::_gsmTask(void* pvParam) {
    GsmManager* self = static_cast<GsmManager*>(pvParam);
    self->_taskLoop();
    vTaskDelete(nullptr);
}

// ─────────────────────────────────────────────────────────────
//  _taskLoop()
// ─────────────────────────────────────────────────────────────
void GsmManager::_taskLoop() {

    // ── Инициализация модема (асинхронная, как в JarvisAsync) ─
    if (!_initModem()) {
        log_e("[GSM] Modem init failed — task will keep retrying");
    }

    // ── Основной цикл ─────────────────────────────────────────
    static uint32_t lastStatusUpdate = 0;
    static uint32_t lastSignalUpdate = 0;

    for (;;) {
        // Обработка входящих событий модема (звонки, SMS, AT-ответы)
        modem.update();

        // Периодическое обновление статуса сети
        uint32_t now = millis();

        if (now - lastSignalUpdate > 30000UL) {
            lastSignalUpdate = now;
            if (modem.isNetworkConnected()) {
                modem.requestSignalLevel();
                modem.requestOperatorName();
            } else {
                modem.requestRegistration(false);
            }
        }

        if (now - lastStatusUpdate > 5000UL) {
            lastStatusUpdate = now;
            _updateStatus();
        }

        // Исходящие SMS по команде из main loop (через _smsQueue)
        GsmSmsCmd smsCmd;
        if (xQueueReceive(_smsQueue, &smsCmd, 0) == pdTRUE) {
            log_i("[GSM] Sending SMS to %s", smsCmd.number);
            if (!modem.sendPDUSMS(smsCmd.number, smsCmd.text)) {
                log_e("[GSM] SMS send failed");
            }
        }

        // Шаговая компактификация БД (не блокирует надолго)
        if (_needCompaction) {
            if (!PhoneBook.isCompactionInProgress()) {
                if (xSemaphoreTake(dbMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    PhoneBook.startCompaction();
                    xSemaphoreGive(dbMutex);
                }
            }
        }

        if (PhoneBook.isCompactionInProgress()) {
            if (xSemaphoreTake(dbMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                auto res = PhoneBook.compactionStep();
                xSemaphoreGive(dbMutex);
                if (res == PhoneDB::CompactionResult::DONE ||
                    res == PhoneDB::CompactionResult::ERROR) {
                    _needCompaction = false;
                    log_i("[GSM] Compaction %s",
                        res == PhoneDB::CompactionResult::DONE ? "done" : "error");
                    // Уведомить main loop
                    char json[64];
                    snprintf(json, sizeof(json),
                        "{\"type\":\"db_compaction\",\"ok\":%s}",
                        res == PhoneDB::CompactionResult::DONE ? "true" : "false");
                    _enqueueMqtt(json);
                }
            }
        }

        // Yield — даём другим задачам на core 0 время
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ─────────────────────────────────────────────────────────────
//  _initModem()  — асинхронная инициализация как в JarvisAsync
// ─────────────────────────────────────────────────────────────
bool GsmManager::_initModem() {
    log_i("[GSM] Starting modem init...");

    // PMU — включить keep-alive для модема
    pmu.setupPMU();

    // Попытка инициализации — begin() запускает hardware sequence
    // Не ждём здесь блокирующе — моdem.update() в цикле ниже
    bool started = modem.begin(_cfg ? _cfg->sim_pin : nullptr);
    if (!started) {
        log_w("[GSM] modem.begin() returned false, retrying in background");
    }

    // Ждём инициализации — продолжаем вызывать modem.update()
    // Таймаут 60 секунд — модем может долго искать сеть
    const uint32_t INIT_TIMEOUT_MS = 60000UL;
    const uint32_t startMs         = millis();

    while (!modem.isInitialized()) {
        modem.update();
        vTaskDelay(pdMS_TO_TICKS(50));

        if (millis() - startMs > INIT_TIMEOUT_MS) {
            log_e("[GSM] Init timeout after %lu ms", INIT_TIMEOUT_MS);
            return false;
        }
    }

    log_i("[GSM] Modem initialized. SIM: %s", modem.pinStateStr());

    // Ждём SIM и сети — но не блокируем бесконечно
    const uint32_t NET_TIMEOUT_MS = 30000UL;
    const uint32_t netStartMs     = millis();

    while (!modem.isSimReady()) {
        modem.update();
        vTaskDelay(pdMS_TO_TICKS(100));
        if (millis() - netStartMs > NET_TIMEOUT_MS) {
            log_w("[GSM] SIM not ready after %lu ms, continuing", NET_TIMEOUT_MS);
            break;
        }
    }

    if (modem.isSimReady()) {
        log_i("[GSM] SIM ready. Waiting for network...");

        const uint32_t regStartMs = millis();
        while (!modem.isNetworkConnected()) {
            modem.update();
            modem.statusUpdateEach(2000);
            vTaskDelay(pdMS_TO_TICKS(100));
            if (millis() - regStartMs > NET_TIMEOUT_MS) {
                log_w("[GSM] Network not found after %lu ms, continuing", NET_TIMEOUT_MS);
                break;
            }
        }

        if (modem.isNetworkConnected()) {
            log_i("[GSM] Network: %s, signal: %s",
                  modem.getOperator(), modem.getSignalBars());
            modem.requestNetworkTime();
        }
    }

    _updateStatus();

    // Публикуем статус инициализации
    char json[128];
    snprintf(json, sizeof(json),
        "{\"type\":\"gsm_init\","
        "\"sim\":%s,\"net\":%s,\"operator\":\"%s\"}",
        modem.isSimReady()          ? "true" : "false",
        modem.isNetworkConnected()  ? "true" : "false",
        modem.getOperator()
    );
    _enqueueMqtt(json);

    return true;
}

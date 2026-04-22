/*
 * Janitor ESP GSM — система управления реле с GSM модулем
 * Платформа: ESP32 TTGO T-Call (SIM800L)
 *
 * Архитектура:
 *   Core 0: GSM task  — звонки, SMS, база телефонов
 *   Core 1: MQTT task + loop() — WiFi, MQTT, реле, портал
 *
 * Файлы:
 *   phone_db.h/cpp     — БД телефонов на LittleFS
 *   sms_journal.h/cpp  — журнал входящих SMS
 *   gsm_mgr.h          — менеджер GSM (FreeRTOS)
 *   gsm_mgr.cpp        — инициализация, публичный интерфейс
 *   gsm_mgr_task.cpp   — FreeRTOS task, инит модема
 *   gsm_mgr_handlers.cpp — обработчики звонков/SMS
 */

#include "config.h"
#include "led.h"
#include "relay.h"
#include "storage.h"
#include "wifi_manager.h"
#include "captive.h"
#include "mqtt_mgr.h"
#include "gsm_mgr.h"
#include "phone_db.h"
#include "sms_journal.h"
#include "autoTime.h"

// ── Глобальный конфиг ─────────────────────────────────────────
DeviceConfig cfg;
DeviceState  deviceState = STATE_PORTAL;

// ─────────────────────────────────────────────────────────────
//  Вспомогательные функции
// ─────────────────────────────────────────────────────────────
bool needPortal() {
  if (!LittleFS.exists(CONFIG_FILE)) return true;
  pinMode(RESET_PIN, INPUT_PULLUP);
  delay(100);
  if (digitalRead(RESET_PIN) == LOW) {
    Serial.println(F("[BOOT] Reset button held"));
    return true;
  }
  if (strlen(cfg.wifi1_ssid) == 0) return true;
  return false;
}

void registerIfNeeded() {
  cfg.printTo(Serial);
  if (!cfg.hasPendingCode()) {
    Serial.println(F("[REG] No pending code"));
    return;
  }
  Serial.println(F("[REG] Registering device..."));
  if (MqttMgr.registerDevice()) {
    Storage.saveMainConfig(cfg);
    Storage.saveRelayConfig(cfg);
    Serial.println(F("[REG] Saved"));
  } else {
    Serial.println(F("[REG] Failed — re-enter code in portal"));
  }
}

void checkTimeSync() {
  static bool synced = false;
  if (synced || !EspTime::isSynced()) return;
  synced = true;
  Serial.print(F("[NTP] Synced: "));
  EspTime::timeTo(Serial);
  // NTP синхронизирован — отключаем GSM синхронизацию времени
  // (через callback она уже обрабатывается в gsm_mgr.cpp)
}

// ─────────────────────────────────────────────────────────────
//  Обработка команд от GSM task (из очереди)
// ─────────────────────────────────────────────────────────────
void processGsmCommands() {
  GsmCommand cmd;
  while (GsmMgr.dequeueCommand(cmd)) {
    switch (cmd.type) {

    case GsmCmdType::RELAY_TRIGGER: {
      // Срабатывание реле по звонку/SMS
      uint8_t changedMask = 0;
      for (uint8_t i = 0; i < MAX_RELAYS; i++) {
        if (!(cmd.relay.relayMask & (1 << i))) continue;
        if (!cfg.relays[i].isValid()) continue;

        if (cmd.relay.durationMs > 0) {
          Relays.pulse(i, cmd.relay.durationMs);
        } else {
          // По умолчанию — импульс из настроек группы (используем pulse с duration=0
          // как признак "использовать настройку группы"), или просто toggle
          Relays.pulse(i, 1000);  // TODO: брать из cfg группы когда добавим поле
        }
        changedMask |= (1 << i);
        Serial.printf("[GSM→RELAY] relay %u triggered by %s (idx=%u)\n",
                      i, cmd.relay.source, cmd.relay.idx);
      }

      if (changedMask && MqttMgr.isConnected()) {
        MqttMgr.publishChanges(changedMask);

        // Публикуем GSM-событие для журнала группы на бэкенде
        char json[192];
        snprintf(json, sizeof(json),
          "{\"type\":\"gsm_event\","
          "\"source\":\"%s\","
          "\"idx\":%u,"
          "\"action\":\"relay_triggered\","
          "\"relay_mask\":%u,"
          "\"ts\":%lu}",
          cmd.relay.source,
          (unsigned)cmd.relay.idx,
          (unsigned)changedMask,
          (unsigned long)time(nullptr)
        );
        MqttMgr.publishEvent(json);
      }
      break;
    }

    case GsmCmdType::MQTT_PUBLISH:
      // Публикация события (GSM статус, unknown SMS, compaction и т.д.)
      if (MqttMgr.isConnected()) {
        MqttMgr.publishEvent(cmd.mqtt.payload);
      }
      break;

    case GsmCmdType::SMS_SEND:
      // Передаём в GSM task обратно через sendSms (уже thread-safe)
      GsmMgr.sendSms(cmd.sms.number, cmd.sms.text);
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Пошаговая инициализация (паттерн из JarvisAsync)
// ─────────────────────────────────────────────────────────────
namespace Init {

enum class Status : uint8_t {
  None,
  Serials,
  FileSystem,
  Config,
  Relay,
  Database,
  GSM,
  WiFi,
  TimeSync,
  MQTT,
  Finishing,
  Error
};

Status nextStep(Status s) {
  using S = Status;
  switch (s) {

  case S::None:
    return S::Serials;

  case S::Serials:
    Serial.begin(115200);
    delay(200);
    Serial.println(F("\n[BOOT] Janitor ESP GSM v" FW_VERSION));
    Led.begin();
    Led.setMode(LedManager::CONNECTING);
    WiFi.mode(WIFI_STA);
    delay(10);
    Crypto::begin();
    return S::FileSystem;

  case S::FileSystem:
    if (!Storage.begin()) {
      Serial.println(F("[BOOT] Storage init failed"));
      return S::Error;
    }
    return S::Config;

  case S::Config: {
    Storage.loadConfig(cfg);
    if (strlen(cfg.server_host) == 0)
      strlcpy(cfg.server_host, SERVER_HOST, sizeof(cfg.server_host));

    Serial.print(F("[CFG] "));
    cfg.printTo(Serial);

    if (needPortal()) {
      Led.setMode(LedManager::PORTAL);
      Portal.begin(cfg);
      while (!Portal.tick()) {
        Led.update();
        delay(1);
      }
      Portal.stop();
      delay(300);
      ESP.restart();
    }
    return S::Relay;
  }

  case S::Relay:
    Relays.begin(cfg);
    return S::Database;

  case S::Database:
    if (!PhoneBook.begin()) {
      Serial.println(F("[DB] PhoneBook init failed (non-critical)"));
    }
    if (!SmsLog.begin()) {
      Serial.println(F("[DB] SmsLog init failed (non-critical)"));
    }
    return S::GSM;

  case S::GSM:
    if (cfg.gsm_enabled) {
      if (!GsmMgr.begin(cfg)) {
        Serial.println(F("[GSM] Manager init failed"));
        return S::Error;
      }
      // Задача запустится на core 0 — инициализация модема асинхронна
      GsmMgr.startTask();
      Serial.println(F("[GSM] Task started"));
    } else {
      Serial.println(F("[GSM] Disabled in config"));
    }
    return S::WiFi;

  case S::WiFi:
    if (!WifiMgr.connect(cfg)) {
      // Нет WiFi — портал для настройки
      Portal.begin(cfg);
      while (!Portal.tick()) {
        Led.update();
        // GSM task уже запущен — обрабатываем очередь даже в портале
        if (cfg.gsm_enabled) processGsmCommands();
        delay(1);
      }
      Portal.stop();
      ESP.restart();
    }
    return S::TimeSync;

  case S::TimeSync: {
    bool needTls = cfg.tls_secure && Storage.hasCert();
    WifiMgr.syncTime(needTls);
    // Синхронизируем TZ из сохранённого конфига
    if (strlen(cfg.tz) > 0) {
      setenv("TZ", cfg.tz, 1);
      tzset();
    }
    return S::MQTT;
  }

  case S::MQTT:
    MqttMgr.begin(cfg);
    registerIfNeeded();
    if (!MqttMgr.connect()) {
      Serial.println(F("[MQTT] Failed, will retry in loop"));
      Led.setMode(LedManager::ERROR);
    } else {
      Led.setMode(LedManager::RUNNING);
    }
    return S::Finishing;

  default:
    return S::Error;
  }
}

} // namespace Init

// ─────────────────────────────────────────────────────────────
//  setup()
// ─────────────────────────────────────────────────────────────
void setup() {
  auto step = Init::Status::None;

  do {
    Led.update();
    step = Init::nextStep(step);

    if (step == Init::Status::Error) {
      Serial.println(F("[BOOT] Critical error — halting"));
      Led.setMode(LedManager::ERROR);
      while (true) { Led.update(); delay(10); }
    }
  } while (step != Init::Status::Finishing);

  deviceState = STATE_RUNNING;
  Serial.println(F("[BOOT] Ready!"));
}

// ─────────────────────────────────────────────────────────────
//  loop()  — core 1
// ─────────────────────────────────────────────────────────────
void loop() {
  // ── Время ───────────────────────────────────────────────────
  checkTimeSync();

  // ── LED ─────────────────────────────────────────────────────
  Led.update();

  // ── Реле — автовыключение импульсов ─────────────────────────
  uint8_t changed = Relays.update();
  if (changed && MqttMgr.isConnected()) {
    MqttMgr.publishChanges(changed);
  }

  // ── WiFi reconnect ──────────────────────────────────────────
  if (!WifiMgr.reconnectIfNeeded(cfg)) {
    Led.setMode(LedManager::ERROR);
    return;
  }

  // ── MQTT tick + reconnect ────────────────────────────────────
  MqttMgr.tick();

  // ── Команды от GSM task ─────────────────────────────────────
  if (cfg.gsm_enabled) {
    processGsmCommands();

    // Пошаговая компактификация БД если запрошена
    if (GsmMgr.isCompacting()) {
      if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        auto res = PhoneBook.compactionStep();
        xSemaphoreGive(GsmMgr.dbMutex);
        if (res == PhoneDB::CompactionResult::DONE) {
          Serial.println(F("[DB] Compaction done"));
        }
      }
    }
  }

  delay(10);
}
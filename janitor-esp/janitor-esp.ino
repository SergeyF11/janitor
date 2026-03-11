/*
 * Janitor ESP — система управления реле
 * v1.2.0 — ESP8266 / ESP32
 *
 * Библиотеки: GyverPortal 3.x, PubSubClient 2.8+, ArduinoJson 6/7, LittleFS
 *
 * Логика:
 *  1. Первый запуск → CaptivePortal (WiFi + реле)
 *  2. Вкладка Привязка → ввести 6-значный код из панели администратора
 *  3. При следующей загрузке ESP отправляет код + список реле на сервер
 *  4. Сервер возвращает MQTT credentials и один общий топик
 *  5. ESP подключается к MQTT и готов принимать команды
 *
 * MQTT:
 *  relay/{topic}/cmd    ← входящие команды: {action, relay, duration?}
 *  relay/{topic}/status → статус всех реле (retained)
 *  sys/devices/{mac}/status → LWT: online/offline (retained)
 */

#include "config.h"
#include "led.h"
#include "relay.h"
#include "storage.h"
#include "wifi_manager.h"
#include "captive.h"
#include "mqtt_mgr.h"

DeviceConfig cfg;
DeviceState  state = STATE_PORTAL;


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
    Storage.saveMainConfig(cfg);   // MQTT credentials + topic
    Storage.saveRelayConfig(cfg);  // реле (без кодов)
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
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n[BOOT] Janitor ESP v" FW_VERSION));

  Led.begin();
  Led.setMode(LedManager::CONNECTING);

  WiFi.mode(WIFI_STA);
  delay(10);
  Crypto::begin();

  if (!Storage.begin()) {
    Led.setMode(LedManager::ERROR);
    while (true) { Led.update(); delay(10); }
  }

  Storage.loadConfig(cfg);
  Serial.print("Config: "); cfg.printTo(Serial);
  Relays.begin(cfg);

  if (needPortal()) {
    state = STATE_PORTAL;
    Portal.begin(cfg);
    while (!Portal.tick()) { delay(1); }
    Portal.stop();
    delay(500);
    ESP.restart();
    return;
  }

  state = STATE_CONNECTING;
  if (!WifiMgr.connect(cfg)) {
    Portal.begin(cfg);
    while (!Portal.tick()) { delay(1); }
    Portal.stop();
    ESP.restart();
    return;
  }

  bool needTls = cfg.tls_secure && Storage.hasCert();
  if (!WifiMgr.syncTime(needTls)) {
    if (needTls) {
      Portal.begin(cfg);
      while (!Portal.tick()) { delay(1); }
      Portal.stop();
      ESP.restart();
      return;
    }
  }
  checkTimeSync();

  MqttMgr.begin(cfg);
  registerIfNeeded();

  if (!MqttMgr.connect()) {
    Serial.println(F("[BOOT] MQTT failed, will retry"));
    Led.setMode(LedManager::ERROR);
  } else {
    Led.setMode(LedManager::RUNNING);
    MqttMgr.publishAllStatuses();
  }

  state = STATE_RUNNING;
  Serial.println(F("[BOOT] Ready!"));
}

void loop() {
  checkTimeSync();
  Led.update();

  // Обновляем реле, при окончании импульса публикуем статус
  if (Relays.update() && MqttMgr.isConnected()) {
    MqttMgr.publishAllStatuses();
  }

  if (!WifiMgr.reconnectIfNeeded(cfg)) {
    Led.setMode(LedManager::ERROR);
    return;
  }

  MqttMgr.tick();
  delay(10);
}

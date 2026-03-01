/*
 * Janitor ESP — система управления реле
 * Версия: 1.0.0
 * Поддержка: ESP8266 / ESP32
 * 
 * Библиотеки (установить через Arduino Library Manager):
 *   - GyverPortal         3.x
 *   - PubSubClient        2.8+
 *   - ArduinoJson         6.x
 *   - LittleFS            (встроена)
 *
 * Для ESP8266: в Board Manager установить esp8266 by ESP8266 Community
 * Для ESP32:   в Board Manager установить esp32 by Espressif
 */

#include "config.h"
#include "led.h"
#include "relay.h"
#include "storage.h"
#include "wifi_manager.h"
#include "captive.h"
#include "mqtt_mgr.h"

// ── Глобальное состояние ──────────────────────────────────────
DeviceConfig cfg;
DeviceState  state = STATE_PORTAL;

// Флаг — нужно ли запустить портал
// (GPIO0 зажат при старте = принудительный портал)
#ifdef ESP32
  #define RESET_PIN RX
#else
  #define RESET_PIN RX  // FLASH кнопка на NodeMCU // D3 для WeMos mini
#endif

// ── Проверить нужен ли портал ─────────────────────────────────
bool needPortal() {
  // Нет конфига — всегда портал
  if (!LittleFS.exists(CONFIG_FILE)) return true;

  // Кнопка FLASH зажата при старте
  pinMode(RESET_PIN, INPUT_PULLUP);
  delay(100);
  if (digitalRead(RESET_PIN) == LOW) {
    Serial.println("[BOOT] Reset button held, starting portal");
    return true;
  }

  // Нет WiFi настроек
  if (strlen(cfg.wifi1_ssid) == 0) return true;

  return false;
}

// ── Регистрация непривязанных реле ───────────────────────────
void registerPendingRelays() {

  cfg.printTo(Serial);

  bool changed = false;
  //auto relay_count = cfg.relayCount();
  for (uint8_t i = 0; i < cfg.relay_count; i++) {
    if (strlen(cfg.relays[i].mqtt_code) == 6) {
      Serial.printf("[BOOT] Relay %d has pending code, registering...\n", i+1);
      if (MqttMgr.registerRelay(i)) {
        changed = true;
      } else {
        Serial.printf("[BOOT] Relay %d registration failed\n", i+1);
      }
    }
  }
  if (changed) Storage.saveConfig(cfg);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n[BOOT] Janitor ESP v" FW_VERSION);
  Serial.println("[BOOT] " + String(
    #ifdef ESP32
      "ESP32"
    #else
      "ESP8266"
    #endif
  ));

  // Инициализация
  Led.begin();
  Led.setMode( LedManager::CONNECTING );

  // Инициализируем крипто (ключ из MAC, нужен WiFi для чтения MAC)
  WiFi.mode(WIFI_STA); delay(1);
  Crypto::begin();

  // Монтируем файловую систему
  if (!Storage.begin()) {
    Serial.println("[BOOT] Storage failed!");
    Led.setMode( LedManager::ERROR );
    while (true) { Led.update(); delay(10); }
  }

  // Загружаем конфиг
  Storage.loadConfig(cfg);

  // Инициализируем реле
  Relays.begin(cfg);

  // Решаем — нужен ли портал
  if (needPortal()) {
    Serial.println("[BOOT] Starting CaptivePortal...");
    state = STATE_PORTAL;
    Portal.begin(cfg);

    // Крутим портал пока пользователь не нажмёт "Завершить"
    while (!Portal.tick()) {
      delay(1);
    }

    Portal.stop();
    Serial.println("[BOOT] Portal closed, restarting...");
    delay(500);
    ESP.restart();
    return;
  }

  // Подключаемся к WiFi
  state = STATE_CONNECTING;
  if (!WifiMgr.connect(cfg)) {
    Serial.println("[BOOT] WiFi failed, starting portal...");
    Portal.begin(cfg);
    while (!Portal.tick()) { delay(1); }
    Portal.stop();
    ESP.restart();
    return;
  }

// Синхронизация времени
  bool needTls = cfg.tls_secure && Storage.hasCert();
  if (!WifiMgr.syncTime(needTls)) {
    Serial.println("[BOOT] NTP failed!");
    if (needTls) {
      // Без времени TLS не работает — уходим в портал
      Portal.begin(cfg);
      while (!Portal.tick()) { delay(1); }
      Portal.stop();
      ESP.restart();
      return;
    }
  }  

  // Инициализируем MQTT
  MqttMgr.begin(cfg);

  // Регистрируем реле если есть коды привязки
  registerPendingRelays();



  // Подключаемся к MQTT
  if (!MqttMgr.connect()) {
    Serial.println("[BOOT] MQTT initial connect failed, will retry in loop");
    Led.setMode( LedManager::ERROR );
    //Led.setMode( LedManager::ERROR );
  } else {
    Led.setMode( LedManager::RUNNING );
  }

  state = STATE_RUNNING;
  Serial.println("[BOOT] Ready!");
}

void loop() {
  Led.update();
  Relays.update();

  // Публикуем статус реле после окончания импульса
  static bool prevState[MAX_RELAYS] = {false};
  for (uint8_t i = 0; i < MAX_RELAYS/* cfg.relay_count */; i++) {
    bool cur = Relays.getState(i);
    if (cur != prevState[i]) {
      prevState[i] = cur;
      MqttMgr.publishRelayStatus(i, cur);
    }
  }

  // Проверяем WiFi
  if (!WifiMgr.reconnectIfNeeded(cfg)) {
    Led.setMode( LedManager::ERROR );
    return;
  }

  // MQTT tick
  MqttMgr.tick();

  delay(10);
}
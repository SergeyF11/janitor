#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"
#include "storage.h"
#include "relay.h"
#include "led.h"

#ifdef ESP32
  #include <WiFi.h>
  #include <WiFiClientSecure.h>
  #include <HTTPClient.h>
  #include <PubSubClient.h>
#else
  #include <ESP8266WiFi.h>
  #include <ESP8266HTTPClient.h>
  #include <WiFiClientSecure.h>
  #include <PubSubClient.h>
#endif

class MqttManager {
public:

  bool begin(DeviceConfig& cfg) {
    _instance = this;
    _cfg = &cfg;
    _setupClient();
    _mqtt.setServer(cfg.mqtt_host, cfg.mqtt_port);
    _mqtt.setCallback([](char* t, byte* p, unsigned int l) {
      if (_instance) _instance->_onMessage(t, p, l);
    });
    _mqtt.setKeepAlive(60);
    _mqtt.setSocketTimeout(10);
    return true;
  }

  // ── Регистрация УСТРОЙСТВА одним запросом ─────────────────
  // Отправляет: mac, код привязки, список всех реле с пинами.
  // Получает:   mqtt_host, mqtt_port, mqtt_user, mqtt_pass, mqtt_topic.
  // Все реле устройства получают ОДИН общий топик.
  bool registerDevice() {
    if (!cfg()->hasPendingCode()) {
      Serial.println(F("[REG] No pending code"));
      return false;
    }

    // Собираем список реле
    JsonDocument req;
    req["mac"]        = WiFi.macAddress();
    req["fw_version"] = FW_VERSION;
    req["code"]       = cfg()->reg_code;
    JsonArray relays  = req.createNestedArray("relays");
    for (uint8_t i = 0; i < MAX_RELAYS; i++) {
      if (!cfg()->relays[i].isValid()) continue;
      JsonObject r = relays.createNestedObject();
      r["index"] = i;
      r["pin"]   = cfg()->relays[i].pin;
      r["name"]  = cfg()->relays[i].name;
    }

    String body; serializeJson(req, body);
    Serial.printf("[REG] POST %s\n%s\n",
      (String("https://") + SERVER_HOST + ":" + SERVER_PORT + API_REGISTER).c_str(),
      body.c_str());

    WiFiClientSecure httpClient;
    httpClient.setInsecure();
    HTTPClient http;
    String url = String(F("https://")) + SERVER_HOST + ":" + SERVER_PORT + API_REGISTER;
    http.begin(httpClient, url);
    http.addHeader("Content-Type", "application/json");

    int code = http.POST(body);
    String resp = http.getString();
    http.end();

    if (code != 200) {
      Serial.printf("[REG] HTTP error: %d\n%s\n", code, resp.c_str());
      return false;
    }

    JsonDocument doc;
    if (deserializeJson(doc, resp) != DeserializationError::Ok) {
      Serial.println(F("[REG] Response JSON error"));
      return false;
    }

    // Сохраняем всё что пришло с сервера
    const char* host  = doc["mqtt_host"] | "";
    const char* topic = doc["mqtt_topic"] | "";

    if (!strlen(host) || !strlen(topic)) {
      Serial.println(F("[REG] Response missing mqtt_host or mqtt_topic"));
      return false;
    }

    strlcpy(cfg()->mqtt_host,  host,                    sizeof(cfg()->mqtt_host));
    cfg()->mqtt_port = doc["mqtt_port"] | MQTT_PORT_TLS;
    strlcpy(cfg()->mqtt_user,  doc["mqtt_user"] | "",   sizeof(cfg()->mqtt_user));
    strlcpy(cfg()->mqtt_pass,  doc["mqtt_pass"] | "",   sizeof(cfg()->mqtt_pass));
    strlcpy(cfg()->mqtt_topic, topic,                   sizeof(cfg()->mqtt_topic));
    cfg()->registered = true;

    // Очищаем код привязки
    memset(cfg()->reg_code, 0, sizeof(cfg()->reg_code));

    // Обновляем MQTT клиент с новым сервером
    _mqtt.setServer(cfg()->mqtt_host, cfg()->mqtt_port);
    _setupClient();

    Serial.printf("[REG] OK — MQTT: %s@%s:%u topic=%s\n",
      cfg()->mqtt_user, cfg()->mqtt_host, cfg()->mqtt_port, cfg()->mqtt_topic);
    return true;
  }

  // ── Подключение к брокеру ─────────────────────────────────
  bool connect() {
    if (!cfg()->isRegistered()) {
      Serial.println(F("[MQTT] Not registered, skip connect"));
      return false;
    }

    Led.setMode(LedManager::CONNECTING);

    String mac = WiFi.macAddress();
    mac.replace(":", "");
    String clientId = String(DEVICE_PREFIX) + "_" + mac;

    // LWT — брокер опубликует при разрыве соединения
    char lwtTopic[64];
    snprintf(lwtTopic, sizeof(lwtTopic), SYS_STATUS_TMPL, mac.c_str());

    Serial.printf("[MQTT] Connecting as %s to %s:%u...\n",
      clientId.c_str(), cfg()->mqtt_host, cfg()->mqtt_port);

    bool ok = _mqtt.connect(
      clientId.c_str(),
      cfg()->mqtt_user,
      cfg()->mqtt_pass,
      lwtTopic, 1, true,
      "{\"online\":false}"
    );

    if (!ok) {
      Serial.printf("[MQTT] Failed, state=%d\n", _mqtt.state());
      Led.setMode(LedManager::ERROR);
      return false;
    }

    Serial.println(F("[MQTT] Connected!"));
    Led.setMode(LedManager::RUNNING);

    // Публикуем online
    _publishOnline(mac);

    // Подписываемся на команды — один топик для всего устройства
    char cmdTopic[128];
    snprintf(cmdTopic, sizeof(cmdTopic), RELAY_CMD_TMPL, cfg()->mqtt_topic);
    _mqtt.subscribe(cmdTopic, 1);
    Serial.printf("[MQTT] Subscribed: %s\n", cmdTopic);

    return true;
  }

  // ── loop() ────────────────────────────────────────────────
  void tick() {
    if (!_mqtt.connected()) {
      unsigned long now = millis();
      if (now - _lastReconnect < MQTT_RECONNECT_MS) return;
      _lastReconnect = now;

      if (_mqtt.state() == MQTT_CONNECT_BAD_CREDENTIALS) {
        _authFails++;
        Serial.printf("[MQTT] Auth failed (%u/3)\n", _authFails);
        if (_authFails >= 3 && cfg()->hasPendingCode()) {
          Serial.println(F("[MQTT] Trying re-register..."));
          if (registerDevice()) {
            Storage.saveMainConfig(*_cfg);
            _authFails = 0;
          }
        }
      }

      Serial.println(F("[MQTT] Reconnecting..."));
      Led.setMode(LedManager::CONNECTING);
      if (connect()) _authFails = 0;
      else Led.setMode(LedManager::ERROR);
      return;
    }

    _authFails = 0;
    _mqtt.loop();
  }

  bool isConnected()  { return _mqtt.connected(); }

  // ── Публикация статуса ВСЕХ реле ─────────────────────────
  // Один retained payload в общий топик устройства.
  // Формат: { "relays": [ {index, state} ... ], "ts": unix }
  void publishAllStatuses() {
    if (!isConnected() || !cfg()->isRegistered()) return;

    JsonDocument doc;
    JsonArray arr = doc.createNestedArray("relays");
    for (uint8_t i = 0; i < Relays.getCount(); i++) {
      JsonObject r = arr.createNestedObject();
      r["index"] = Relays.getCfgIndex(i);
      r["state"] = Relays.getState(i) ? "on" : "off";
    }
    doc["ts"] = (uint32_t)time(nullptr);

    char topic[128];
    snprintf(topic, sizeof(topic), RELAY_STATUS_TMPL, cfg()->mqtt_topic);
    String payload; serializeJson(doc, payload);
    _mqtt.publish(topic, payload.c_str(), true);
    Serial.printf("[MQTT] → %s: %s\n", topic, payload.c_str());
  }

private:
  DeviceConfig*    _cfg      = nullptr;
  WiFiClientSecure _secureClient;
  WiFiClientSecure _insecureClient;
  PubSubClient     _mqtt;
  unsigned long    _lastReconnect = 0;
  uint8_t          _authFails     = 0;
  static MqttManager* _instance;

  #ifndef ESP32
  X509List _x509;
  #endif

  DeviceConfig* cfg() { return _cfg; }

  void _setupClient() {
    if (_cfg && _cfg->tls_secure && Storage.hasCert()) {
      Serial.println(F("[MQTT] TLS: secure"));
      uint8_t* buf; size_t len;
      if (Storage.loadCert(&buf, &len)) {
        #ifdef ESP32
          _secureClient.setCACert((const char*)buf);
        #else
          _x509.append(buf, len);
          _secureClient.setTrustAnchors(&_x509);
        #endif
        delete[] buf;
      }
      _mqtt.setClient(_secureClient);
    } else {
      Serial.println(F("[MQTT] TLS: insecure"));
      _insecureClient.setInsecure();
      _mqtt.setClient(_insecureClient);
    }
  }

  // Входящее MQTT сообщение — команда реле
  // Формат: { "action": "pulse"|"on"|"off", "relay": 0, "duration": 500 }
  // relay — индекс реле (из cfg), если не указан — первое реле
  void _onMessage(char* topic, byte* payload, unsigned int len) {
    String msg;
    msg.reserve(len);
    for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
    Serial.printf("[MQTT] ← %s: %s\n", topic, msg.c_str());

    JsonDocument doc;
    if (deserializeJson(doc, msg) != DeserializationError::Ok) {
      Serial.println(F("[MQTT] JSON error"));
      return;
    }

    const char* action   = doc["action"]   | "";
    uint32_t    duration = doc["duration"] | 0;
    int8_t      cfgIdx   = doc["relay"]    | 0;   // индекс реле в cfg.relays[]

    // Найти реле в RelayManager по cfg index
    int8_t relayIdx = Relays.findByCfgIndex((uint8_t)cfgIdx);
    if (relayIdx < 0) {
      Serial.printf("[MQTT] Relay cfg[%d] not found\n", cfgIdx);
      return;
    }

    if (strcmp(action, "pulse") == 0 && duration > 0) {
      Serial.printf("[CMD] pulse relay[%d] %ums\n", cfgIdx, duration);
      Relays.pulse((uint8_t)relayIdx, duration);
    } else if (strcmp(action, "on") == 0) {
      Serial.printf("[CMD] on relay[%d]\n", cfgIdx);
      Relays.setState((uint8_t)relayIdx, true);
    } else if (strcmp(action, "off") == 0) {
      Serial.printf("[CMD] off relay[%d]\n", cfgIdx);
      Relays.setState((uint8_t)relayIdx, false);
    } else {
      Serial.printf("[CMD] unknown action: %s\n", action);
      return;
    }

    publishAllStatuses();
  }

  void _publishOnline(const String& mac) {
    char topic[64];
    snprintf(topic, sizeof(topic), SYS_STATUS_TMPL, mac.c_str());
    JsonDocument doc;
    doc["online"]     = true;
    doc["fw_version"] = FW_VERSION;
    doc["mac"]        = WiFi.macAddress();
    doc["ip"]         = WiFi.localIP().toString();
    doc["relays"]     = (int)Relays.getCount();
    doc["topic"]      = cfg()->mqtt_topic;
    String payload; serializeJson(doc, payload);
    _mqtt.publish(topic, payload.c_str(), true);
    Serial.printf("[MQTT] Online → %s\n", topic);
  }
};

extern MqttManager MqttMgr;

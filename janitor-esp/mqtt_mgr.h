#pragma once
#define MQTT_MAX_PACKET_SIZE 1024

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
    _mqtt.setKeepAlive(3600);
    _mqtt.setSocketTimeout(10);
    _mqtt.setBufferSize(512);
    return true;
  }

  // ── Регистрация устройства ────────────────────────────────
  // Отправляет: mac, код, список реле с именами
  // Получает:   mqtt_host, mqtt_port, mqtt_user, mqtt_pass, registry_id
  bool registerDevice() {
    if (!cfg()->hasPendingCode()) {
      Serial.println(F("[REG] No pending code"));
      return false;
    }

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

    const char* host       = doc["mqtt_host"]   | "";
    const char* mqttUser   = doc["mqtt_user"]   | "";
    const char* mqttPass   = doc["mqtt_pass"]   | "";
    const char* registryId = doc["registry_id"] | "";  // опционально — только для Яндекс
    const char* mqttTopic  = doc["mqtt_topic"]  | "";  // опционально — только для local

    // host и mqttUser обязательны для обоих провайдеров
    if (!strlen(host) || !strlen(mqttUser)) {
      Serial.println(F("[REG] Response missing required fields"));
      return false;
    }

    strlcpy(cfg()->mqtt_host,   host,       sizeof(cfg()->mqtt_host));
    strlcpy(cfg()->mqtt_user,   mqttUser,   sizeof(cfg()->mqtt_user));
    strlcpy(cfg()->mqtt_pass,   mqttPass,   sizeof(cfg()->mqtt_pass));
    if (strlen(mqttTopic))
      strlcpy(cfg()->mqtt_topic,   mqttTopic,   sizeof(cfg()->mqtt_topic));
    if (strlen(registryId))
      strlcpy(cfg()->registry_id, registryId, sizeof(cfg()->registry_id));
    cfg()->mqtt_port  = doc["mqtt_port"] | MQTT_PORT_TLS;
    cfg()->registered = true;

    memset(cfg()->reg_code, 0, sizeof(cfg()->reg_code));

    _mqtt.setServer(cfg()->mqtt_host, cfg()->mqtt_port);
    _setupClient();

    Serial.printf("[REG] OK: MQTT %s@%s:%u topic=%s\n",
      cfg()->mqtt_user, cfg()->mqtt_host, cfg()->mqtt_port, cfg()->mqtt_topic);

    for (uint8_t i = 0; i < MAX_RELAYS; i++) {
      if (!cfg()->relays[i].isValid()) continue;
      Serial.printf("[REG] relay[%u] name=%s\n", i, cfg()->relays[i].name);
    }
    return true;
  }

  // ── Подключение к брокеру ─────────────────────────────────
  bool connect() {
    if (!cfg()->isRegistered()) {
      Serial.println(F("[MQTT] Not registered, skip connect"));
      return false;
    }

    Led.setMode(LedManager::CONNECTING);

    // Для local и Яндекса используем одинаковую device-модель:
    //   $devices/{user}/commands
    //   $devices/{user}/events
    char lwtTopic[128];
    String macId = WiFi.macAddress();
    macId.replace(":", ""); macId.toUpperCase();
    // if (cfg()->isYandex()) {
    //   snprintf(lwtTopic, sizeof(lwtTopic), DEVICE_EVENTS_TMPL, cfg()->mqtt_user);
    // } else {
    //   snprintf(lwtTopic, sizeof(lwtTopic), "sys/devices/%s/status", macId.c_str());
    // }
    snprintf(lwtTopic, sizeof(lwtTopic), DEVICE_EVENTS_TMPL, cfg()->mqtt_user);

    auto clientId = cfg()->mqtt_user;
    char lwtPayload[32];
    snprintf(lwtPayload, sizeof(lwtPayload), "{\"online\":false}");

    Serial.printf("[MQTT] Connecting %s as %s to %s:%u...\n", macId.c_str(),
       clientId, cfg()->mqtt_host, cfg()->mqtt_port);

    bool ok = _mqtt.connect(
      clientId,
      cfg()->mqtt_user,
      cfg()->mqtt_pass,
      lwtTopic, 1, true,
      lwtPayload, true
    );

    if (!ok) {
      Serial.printf("[MQTT] Failed, state=%d\n", _mqtt.state());
      Led.setMode(LedManager::ERROR);
      return false;
    }

    Serial.println(F("[MQTT] Connected!"));
    Serial.printf("[LWT] %s to %s\n", lwtPayload, lwtTopic);

    Led.setMode(LedManager::RUNNING);

    // Подписка на команды 
    char cmdTopic[80];
    snprintf(cmdTopic, sizeof(cmdTopic), DEVICE_CMD_TMPL, cfg()->mqtt_user);
    _mqtt.subscribe(cmdTopic, 1);
    Serial.printf("[MQTT] Subscribed: %s\n", cmdTopic);

    publishOnline();
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

  bool isConnected() { return _mqtt.connected(); }

  // ── Публикация online + статус всех реле ──────────────────
  void publishOnline() {
    if (!isConnected() || !cfg()->isRegistered()) return;

    JsonDocument doc;
    //doc["device"] = cfg()->mqtt_user;  // YC device ID
    doc["online"] = true;
    doc["fw"]     = FW_VERSION;
    doc["ts"]     = (uint32_t)time(nullptr);
    JsonArray arr = doc.createNestedArray("relays");
    for (uint8_t i = 0; i < Relays.getCount(); i++) {
      uint8_t cfgIdx = Relays.getCfgIndex(i);
      JsonObject r = arr.createNestedObject();
      r["name"]  = cfg()->relays[cfgIdx].name;
      r["state"] = Relays.getState(i) ? "on" : "off";
    }

    char topic[80];
    snprintf(topic, sizeof(topic), DEVICE_EVENTS_TMPL, cfg()->mqtt_user);

    String payload; serializeJson(doc, payload);
    _mqtt.publish(topic, payload.c_str(), false);
    Serial.printf("[MQTT] → online: %s\n", payload.c_str());
  }

  // ── Публикация изменений реле ─────────────────────────────
  void publishChanges(uint8_t changedMask) {
    if (!isConnected() || !cfg()->isRegistered() || !changedMask) return;

    JsonDocument doc;
    //doc["device"] = cfg()->mqtt_user;  // YC device ID
    doc["ts"]     = (uint32_t)time(nullptr);
    JsonArray arr = doc.createNestedArray("relays");
    for (uint8_t i = 0; i < Relays.getCount(); i++) {
      if (!(changedMask & (1 << i))) continue;
      uint8_t cfgIdx = Relays.getCfgIndex(i);
      JsonObject r = arr.createNestedObject();
      r["name"]  = cfg()->relays[cfgIdx].name;
      r["state"] = Relays.getState(i) ? "on" : "off";
      //r["ts"]    = (uint32_t)time(nullptr);
    }

    
    char topic[80];
    snprintf(topic, sizeof(topic), DEVICE_EVENTS_TMPL, cfg()->mqtt_user);
    String payload; serializeJson(doc, payload);
    _mqtt.publish(topic, payload.c_str(), false);
    Serial.printf("[MQTT] → changes: %s\n", payload.c_str());
  }

private:
  DeviceConfig*    _cfg          = nullptr;
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

  // ── Входящая команда ──────────────────────────────────────
  // {"relay":"Base","action":"pulse","duration":500}
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

    const char* relayName = doc["relay"]    | "";
    const char* action    = doc["action"]   | "";
    uint32_t    duration  = doc["duration"] | 0;

    int8_t relayIdx = _findRelayByName(relayName);
    if (relayIdx < 0) {
      Serial.printf("[MQTT] Relay with name '%s' not found\n", relayName);
      return;
    }

    uint8_t changedMask = 0;
    if (strcmp(action, "pulse") == 0 && duration > 0) {
      Serial.printf("[CMD] pulse relay '%s' %ums\n", relayName, duration);
      Relays.pulse((uint8_t)relayIdx, duration);
      changedMask = (1 << relayIdx);
    } else if (strcmp(action, "on") == 0) {
      Serial.printf("[CMD] on relay '%s'\n", relayName);
      Relays.setState((uint8_t)relayIdx, true);
      changedMask = (1 << relayIdx);
    } else if (strcmp(action, "off") == 0) {
      Serial.printf("[CMD] off relay '%s'\n", relayName);
      Relays.setState((uint8_t)relayIdx, false);
      changedMask = (1 << relayIdx);
    } else if (strcmp(action, "toggle") == 0) {
      bool cur = Relays.getState((uint8_t)relayIdx);
      Serial.printf("[CMD] toggle relay '%s' -> %s\n", relayName, cur ? "off" : "on");
      Relays.setState((uint8_t)relayIdx, !cur);
      changedMask = (1 << relayIdx);
    } else {
      Serial.printf("[CMD] unknown action: %s\n", action);
      return;
    }

    publishChanges(changedMask);
  }

  int8_t _findRelayByName(const char* name) {
    if (!strlen(name)) return -1;
    for (uint8_t i = 0; i < Relays.getCount(); i++) {
      uint8_t cfgIdx = Relays.getCfgIndex(i);
      if (strcasecmp(cfg()->relays[cfgIdx].name, name) == 0)
        return (int8_t)i;
    }
    return -1;
  }
};

extern MqttManager MqttMgr;
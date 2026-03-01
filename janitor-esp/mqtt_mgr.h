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

    // Настраиваем WiFi клиент
    if (cfg.tls_secure && Storage.hasCert()) {
      Serial.println("[MQTT] TLS mode: secure (CA cert)");
      uint8_t* certBuf;
      size_t   certLen;
      if (Storage.loadCert(&certBuf, &certLen)) {
        #ifdef ESP32
          _secureClient.setCACert((const char*)certBuf);
        #else
          _x509.append(certBuf, certLen);
          _secureClient.setTrustAnchors(&_x509);
        #endif
        delete[] certBuf;
      }
      _mqtt.setClient(_secureClient);
    } else {
      Serial.println("[MQTT] TLS mode: insecure");
      _insecureClient.setInsecure();
      _mqtt.setClient(_insecureClient);
    }

    _mqtt.setServer(cfg.mqtt_host, cfg.mqtt_port);
    _mqtt.setCallback([](char* topic, byte* payload, unsigned int len) {
      if ( _instance) _instance->_onMessage(topic, payload, len);
    });
    _mqtt.setKeepAlive(60);
    _mqtt.setSocketTimeout(10);

    return true;
  }

  // Регистрация реле — обновлённая версия
  bool registerRelay(uint8_t relayIndex) {

    if (relayIndex >= _cfg->relay_count ) return false;
    const char* code = _cfg->relays[relayIndex].mqtt_code;
    if (strlen(code) != 6) return false;

    Serial.printf("[REG] Registering relay %d with code %s\n", relayIndex, code);

    WiFiClientSecure httpClient;
    httpClient.setInsecure();

    HTTPClient http;
    String url = String("https://") + SERVER_HOST + ":" + SERVER_PORT + API_REGISTER;
    http.begin(httpClient, url);
    http.addHeader("Content-Type", "application/json");

    JsonDocument req;
    req["code"]        = code;
    req["mac"]         = WiFi.macAddress();
    req["relay_index"] = relayIndex;
    req["fw_version"]  = FW_VERSION;
    String body;
    serializeJson(req, body);

    int httpCode = http.POST(body);
    if (httpCode != 200) {
      Serial.printf("[REG] HTTP error: %d\n", httpCode);
      http.end();
      return false;
    }

    JsonDocument doc;
    
    if (deserializeJson(doc, http.getString()) != DeserializationError::Ok) {
      http.end();
      return false;
    }
    http.end();

    // Сохраняем MQTT credentials (общие для всего устройства)
    strlcpy(_cfg->mqtt_user, doc["mqtt_user"] | "", sizeof(_cfg->mqtt_user));
    strlcpy(_cfg->mqtt_pass, doc["mqtt_pass"] | "", sizeof(_cfg->mqtt_pass));
    _cfg->registered = true;

    // Сохраняем топики для каждого реле из ответа
    JsonArray relays = doc["relays"].as<JsonArray>();
    for (JsonObject r : relays) {
      uint8_t idx = r["relay_index"] | 0;
      if (idx < MAX_RELAYS) {
        // Сохраняем топик в имени реле через разделитель |
        String name = _cfg->relays[idx].name;
        int sep = name.indexOf('|');
        if (sep >= 0) name = name.substring(0, sep);
        name += "|";
        name += (const char*)(r["mqtt_topic"] | "");
        strlcpy(_cfg->relays[idx].name, name.c_str(), sizeof(_cfg->relays[idx].name));
      }
    }

    // Очищаем использованный код
    memset(_cfg->relays[relayIndex].mqtt_code, 0, sizeof(_cfg->relays[relayIndex].mqtt_code));

    Serial.printf("[REG] Done! MQTT user: %s\n", _cfg->mqtt_user);
    return true;
  }

  // Подключиться к MQTT брокеру
  bool connect() {
    if (!strlen(_cfg->mqtt_user)) {
      Serial.println("[MQTT] No credentials, skip connect");
      return false;
    }

    Led.setMode( LedManager::CONNECTING );

    // Формируем client ID из MAC
    String mac = WiFi.macAddress();
    mac.replace(":", "");
    String clientId = String(DEVICE_PREFIX) + "_" + mac;

    // LWT сообщение
    String lwtTopic = String("sys/devices/") + mac + "/status";

    Serial.printf("[MQTT] Connecting as %s...\n", clientId.c_str());

    bool ok = _mqtt.connect(
      clientId.c_str(),
      _cfg->mqtt_user,
      _cfg->mqtt_pass,
      lwtTopic.c_str(),
      1, true,
      "{\"online\":false}"
    );

    if (!ok) {
      Serial.printf("[MQTT] Failed, state: %d\n", _mqtt.state());
      Led.setMode( LedManager::ERROR);
      return false;
    }

    Serial.println("[MQTT] Connected!");
    Led.setMode( LedManager::RUNNING);

    // Публикуем онлайн статус
    _publishOnline(mac);

    // Подписываемся на топики команд для каждого реле
    for (uint8_t i = 0; i < _cfg->relay_count ; i++) {
      // Топик: relay/{groupTopic}/trigger
      // groupTopic берём из конфига (заполняется при регистрации)
      String topic = String("relay/") + _getGroupTopic(i) + "/trigger";
      _mqtt.subscribe(topic.c_str(), 1);
      Serial.printf("[MQTT] Subscribed: %s\n", topic.c_str());
    }

    _lastHeartbeat = millis();
    return true;
  }

  // Вызывать в loop()
void tick() {
    if (!_mqtt.connected()) {
      unsigned long now = millis();
      if (now - _lastReconnect > MQTT_RECONNECT_MS) {
        _lastReconnect = now;

        if (_mqtt.state() == 5) {
          _authFailCount++;
          Serial.printf("[MQTT] Auth failed (%d/3)\n", _authFailCount);
          if (_authFailCount >= 3) {
            // Credentials устарели — перерегистрируемся по новому коду
            // Код должен быть введён через портал заранее
            Serial.println("[MQTT] Trying re-register with saved code...");
            bool reregistered = false;
            for (uint8_t i = 0; i < _cfg-> relay_count ; i++) {
              if (strlen(_cfg->relays[i].mqtt_code) == 6) {
                if (registerRelay(i)) {

                  Storage.saveConfig(*_cfg);
                  reregistered = true;
                }
              }
            }
            if (reregistered) {
              _authFailCount = 0;
              connect();
              return;
            }
          }
        }

        Serial.println("[MQTT] Reconnecting...");
        Led.setMode( LedManager::CONNECTING );
        if (connect()) {
          _authFailCount = 0;
          Led.setMode( LedManager::RUNNING);
        } else {
          Led.setMode( LedManager::ERROR);
        }
      }
      return;
    }

    _authFailCount = 0;
    _mqtt.loop();

    unsigned long now = millis();
    if (now - _lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
      _lastHeartbeat = now;
      _publishHeartbeat();
    }
  }

  bool isConnected() { return _mqtt.connected(); }

  // Публикация статуса реле
  void publishRelayStatus(uint8_t relayIndex, bool state) {
    if (!isConnected()) return;
    String topic = String("relay/") + _getGroupTopic(relayIndex) + "/status";
    String payload = state ? "{\"state\":\"on\"}" : "{\"state\":\"off\"}";
    _mqtt.publish(topic.c_str(), payload.c_str(), true); // retained
  }

private:
  DeviceConfig*     _cfg;
  WiFiClientSecure  _secureClient;
  WiFiClientSecure  _insecureClient;
  PubSubClient      _mqtt;
  unsigned long     _lastReconnect  = 0;
  unsigned long     _lastHeartbeat  = 0;
  static MqttManager* _instance;

  #ifndef ESP32
  X509List _x509;
  #endif

  uint8_t _authFailCount = 0;
  bool    _reregistering = false;
  
  // Получить MQTT топик группы для реле
  // Топик хранится в имени реле после регистрации
  // Формат имени после регистрации: "name|topic"
  String _getGroupTopic(uint8_t index) {
    String name = _cfg->relays[index].name;
    int sep = name.indexOf('|');
    if (sep >= 0) return name.substring(sep + 1);
    return name; // fallback
  }

  void _onMessage(char* topic, byte* payload, unsigned int len) {
    String topicStr = topic;
    String msg;
    for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];

    Serial.printf("[MQTT] Message: %s = %s\n", topic, msg.c_str());

    // Парсим команду
    JsonDocument doc;
    if (deserializeJson(doc, msg) != DeserializationError::Ok) return;

    const char* action   = doc["action"] | "";
    uint32_t    duration = doc["duration"] | 0;

    // Находим нужное реле по топику
    for (uint8_t i = 0; i < _cfg-> relay_count ; i++) {
      String expected = String("relay/") + _getGroupTopic(i) + "/trigger";
      if (topicStr != expected) continue;

      if (strcmp(action, "pulse") == 0 && duration > 0) {
        // Импульсный режим
        Serial.printf("[RELAY] Pulse relay %d for %dms\n", i, duration);
        Relays.pulse(i, duration);
        publishRelayStatus(i, true);
        // Статус OFF опубликуем когда реле выключится (в главном loop)
      } else if (strcmp(action, "on") == 0) {
        // Триггер ВКЛ
        Serial.printf("[RELAY] ON relay %d\n", i);
        Relays.setState(i, true);
        publishRelayStatus(i, true);
      } else if (strcmp(action, "off") == 0) {
        // Триггер ВЫКЛ
        Serial.printf("[RELAY] OFF relay %d\n", i);
        Relays.setState(i, false);
        publishRelayStatus(i, false);
      }
      break;
    }
  }

  void _publishOnline(const String& mac) {
    String topic = String("sys/devices/") + mac + "/status";
    JsonDocument doc;
    doc["online"]     = true;
    doc["fw_version"] = FW_VERSION;
    doc["mac"]        = WiFi.macAddress();
    doc["ip"]         = WiFi.localIP().toString();
    String payload;
    serializeJson(doc, payload);
    _mqtt.publish(topic.c_str(), payload.c_str(), true);
  }

  void _publishHeartbeat() {
    String mac = WiFi.macAddress();
    mac.replace(":", "");
    String topic = String("sys/devices/") + mac + "/heartbeat";
    JsonDocument doc;
    doc["ts"]   = time(nullptr); // millis();
    doc["heap"] = ESP.getFreeHeap();
    String payload;
    serializeJson(doc, payload);
    _mqtt.publish(topic.c_str(), payload.c_str());
    Serial.printf("[Heartbeat] %s = %s\n", topic.c_str(), payload.c_str());
  }
};

extern MqttManager MqttMgr;
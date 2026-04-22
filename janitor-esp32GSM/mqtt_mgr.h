#pragma once
#define MQTT_MAX_PACKET_SIZE 4096   // увеличен для backup_db

#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"
#include "storage.h"
#include "relay.h"
#include "led.h"
#include "phone_db.h"
#include "sms_journal.h"
#include "gsm_mgr.h"

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

// Forward declaration — нужен для GSM команд
class GsmManager;
extern GsmManager GsmMgr;

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
    _mqtt.setKeepAlive(cfg.isYandex() ? 3600 : 60);
    _mqtt.setSocketTimeout(10);
    _mqtt.setBufferSize(MQTT_MAX_PACKET_SIZE);
    return true;
  }

  // ── Регистрация устройства ────────────────────────────────
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
    const char* registryId = doc["registry_id"] | "";
    const char* mqttTopic  = doc["mqtt_topic"]  | "";

    if (!strlen(host) || !strlen(mqttUser)) {
      Serial.println(F("[REG] Response missing required fields"));
      return false;
    }

    strlcpy(cfg()->mqtt_host,  host,       sizeof(cfg()->mqtt_host));
    strlcpy(cfg()->mqtt_user,  mqttUser,   sizeof(cfg()->mqtt_user));
    strlcpy(cfg()->mqtt_pass,  mqttPass,   sizeof(cfg()->mqtt_pass));
    if (strlen(mqttTopic))  strlcpy(cfg()->mqtt_topic,  mqttTopic,  sizeof(cfg()->mqtt_topic));
    if (strlen(registryId)) strlcpy(cfg()->registry_id, registryId, sizeof(cfg()->registry_id));
    cfg()->mqtt_port  = doc["mqtt_port"] | MQTT_PORT_TLS;
    cfg()->registered = true;
    memset(cfg()->reg_code, 0, sizeof(cfg()->reg_code));

    _mqtt.setServer(cfg()->mqtt_host, cfg()->mqtt_port);
    _setupClient();

    Serial.printf("[REG] OK: MQTT %s@%s:%u\n",
      cfg()->mqtt_user, cfg()->mqtt_host, cfg()->mqtt_port);
    return true;
  }

  // ── Подключение ───────────────────────────────────────────
  bool connect() {
    if (!cfg()->isRegistered()) {
      Serial.println(F("[MQTT] Not registered, skip connect"));
      return false;
    }

    Led.setMode(LedManager::CONNECTING);

    char lwtTopic[128];
    snprintf(lwtTopic, sizeof(lwtTopic), DEVICE_EVENTS_TMPL, cfg()->mqtt_user);

    char lwtPayload[32];
    snprintf(lwtPayload, sizeof(lwtPayload), "{\"online\":false}");

    Serial.printf("[MQTT] Connecting as %s to %s:%u...\n",
      cfg()->mqtt_user, cfg()->mqtt_host, cfg()->mqtt_port);

    bool ok = _mqtt.connect(
      cfg()->mqtt_user,
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
    Led.setMode(LedManager::RUNNING);

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

  // ── Публикации ────────────────────────────────────────────
  void publishOnline() {
    if (!isConnected() || !cfg()->isRegistered()) return;

    JsonDocument doc;
    doc["online"] = true;
    doc["fw"]     = FW_VERSION;
    doc["ts"]     = (uint32_t)time(nullptr);

    // GSM статус в online-сообщении
    #ifdef GSM_VARIANT
    doc["gsm"] = cfg()->gsm_enabled;
    if (cfg()->gsm_enabled) {
      doc["unread_sms"] = SmsLog.unreadCount();
    }
    #endif

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

  void publishChanges(uint8_t changedMask) {
    if (!isConnected() || !cfg()->isRegistered() || !changedMask) return;

    JsonDocument doc;
    doc["ts"]  = (uint32_t)time(nullptr);
    JsonArray arr = doc.createNestedArray("relays");
    for (uint8_t i = 0; i < Relays.getCount(); i++) {
      if (!(changedMask & (1 << i))) continue;
      uint8_t cfgIdx = Relays.getCfgIndex(i);
      JsonObject r = arr.createNestedObject();
      r["name"]  = cfg()->relays[cfgIdx].name;
      r["state"] = Relays.getState(i) ? "on" : "off";
    }

    char topic[80];
    snprintf(topic, sizeof(topic), DEVICE_EVENTS_TMPL, cfg()->mqtt_user);
    String payload; serializeJson(doc, payload);
    _mqtt.publish(topic, payload.c_str(), false);
    Serial.printf("[MQTT] → changes: %s\n", payload.c_str());
  }

  void publishEvent(const char* jsonPayload) {
    if (!isConnected() || !cfg()->isRegistered()) return;
    char topic[80];
    snprintf(topic, sizeof(topic), DEVICE_EVENTS_TMPL, cfg()->mqtt_user);
    _mqtt.publish(topic, jsonPayload, false);
    Serial.printf("[MQTT] → event: %s\n", jsonPayload);
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

    const char* action = doc["action"] | "";

    // ── GSM команды ───────────────────────────────────────────
    #ifdef GSM_VARIANT
    if (cfg()->gsm_enabled && (
        strcmp(action, "set_phone")         == 0 ||
        strcmp(action, "del_phone")         == 0 ||
        strcmp(action, "get_phone")         == 0 ||
        strcmp(action, "get_sms_journal")   == 0 ||
        strcmp(action, "send_sms")          == 0 ||
        strcmp(action, "clear_sms_journal") == 0 ||
        strcmp(action, "get_gsm_status")    == 0 ||
        strcmp(action, "trigger_compaction")== 0 ||
        strcmp(action, "backup_db")         == 0 ||
        strcmp(action, "restore_db_chunk")  == 0)) {
      _handleGsmCommand(doc);
      return;
    }
    #endif

    // ── Реле команды ──────────────────────────────────────────
    const char* relayName = doc["relay"]    | "";
    uint32_t    duration  = doc["duration"] | 0;

    int8_t relayIdx = _findRelayByName(relayName);
    if (relayIdx < 0) {
      Serial.printf("[MQTT] Relay '%s' not found\n", relayName);
      return;
    }

    uint8_t changedMask = 0;
    if (strcmp(action, "pulse") == 0 && duration > 0) {
      Relays.pulse((uint8_t)relayIdx, duration);
      changedMask = (1 << relayIdx);
    } else if (strcmp(action, "on") == 0) {
      Relays.setState((uint8_t)relayIdx, true);
      changedMask = (1 << relayIdx);
    } else if (strcmp(action, "off") == 0) {
      Relays.setState((uint8_t)relayIdx, false);
      changedMask = (1 << relayIdx);
    } else if (strcmp(action, "toggle") == 0) {
      Relays.setState((uint8_t)relayIdx, !Relays.getState((uint8_t)relayIdx));
      changedMask = (1 << relayIdx);
    } else {
      Serial.printf("[MQTT] Unknown action: %s\n", action);
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

  // ─────────────────────────────────────────────────────────
  //  GSM команды от бэкенда
  // ─────────────────────────────────────────────────────────
  #ifdef GSM_VARIANT

  void _handleGsmCommand(JsonDocument& doc) {
    const char* action = doc["action"] | "";

    // ── set_phone ────────────────────────────────────────────
    // {"action":"set_phone","idx":42,"phone":"79991234567","relays":3}
    if (strcmp(action, "set_phone") == 0) {
      uint16_t    idx    = doc["idx"]    | 0;
      const char* phone  = doc["phone"]  | "";
      uint8_t     relays = doc["relays"] | 1;

      if (!idx || !strlen(phone)) {
        publishEvent("{\"type\":\"cmd_result\",\"action\":\"set_phone\","
                     "\"ok\":false,\"err\":\"missing_params\"}");
        return;
      }
      uint64_t num = _phoneStrToUint64(phone);
      if (num == 0) {
        publishEvent("{\"type\":\"cmd_result\",\"action\":\"set_phone\","
                     "\"ok\":false,\"err\":\"invalid_phone\"}");
        return;
      }

      bool ok = false;
      if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        ok = PhoneBook.add(num, relays, idx);
        xSemaphoreGive(GsmMgr.dbMutex);
      }
      char resp[96];
      snprintf(resp, sizeof(resp),
        "{\"type\":\"cmd_result\",\"action\":\"set_phone\","
        "\"idx\":%u,\"ok\":%s}",
        (unsigned)idx, ok ? "true" : "false");
      publishEvent(resp);
    }

    // ── del_phone ────────────────────────────────────────────
    // {"action":"del_phone","idx":42}
    else if (strcmp(action, "del_phone") == 0) {
      uint16_t idx = doc["idx"] | 0;
      if (!idx) return;

      bool ok = false;
      if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        ok = PhoneBook.remove(idx);
        xSemaphoreGive(GsmMgr.dbMutex);
      }
      char resp[96];
      snprintf(resp, sizeof(resp),
        "{\"type\":\"cmd_result\",\"action\":\"del_phone\","
        "\"idx\":%u,\"ok\":%s}",
        (unsigned)idx, ok ? "true" : "false");
      publishEvent(resp);
    }

    // ── get_phone ─────────────────────────────────────────────
    // {"action":"get_phone","idx":42}
    // Номер телефона не хранится на сервере — ESP отвечает напрямую
    else if (strcmp(action, "get_phone") == 0) {
      uint16_t idx = doc["idx"] | 0;
      if (!idx) return;

      PhoneRecord rec;
      bool found = false;
      if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        found = PhoneBook.getByIdx(idx, rec);
        xSemaphoreGive(GsmMgr.dbMutex);
      }

      char resp[128];
      if (found) {
        char phoneStr[16];
        _uint64ToPhoneStr(rec.getPhone(), phoneStr, sizeof(phoneStr));
        snprintf(resp, sizeof(resp),
          "{\"type\":\"phone_response\","
          "\"idx\":%u,\"phone\":\"%s\",\"relays\":%u}",
          (unsigned)idx, phoneStr, (unsigned)rec.getRelays());
      } else {
        snprintf(resp, sizeof(resp),
          "{\"type\":\"phone_response\","
          "\"idx\":%u,\"found\":false}",
          (unsigned)idx);
      }
      publishEvent(resp);
    }

    // ── get_sms_journal ───────────────────────────────────────
    // {"action":"get_sms_journal","max":10}
    else if (strcmp(action, "get_sms_journal") == 0) {
      uint8_t maxEntries = doc["max"] | 10;
      static char jbuf[768];
      if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        SmsLog.toJson(jbuf, sizeof(jbuf), maxEntries);
        xSemaphoreGive(GsmMgr.dbMutex);
      }
      static char fullResp[800];
      snprintf(fullResp, sizeof(fullResp),
        "{\"type\":\"sms_journal\",\"data\":%s}", jbuf);
      publishEvent(fullResp);
    }

    // ── send_sms ──────────────────────────────────────────────
    // {"action":"send_sms","to":"XXXX","text":"1","journal_idx":0}
    else if (strcmp(action, "send_sms") == 0) {
      const char* to   = doc["to"]   | "";
      const char* text = doc["text"] | "";
      if (!strlen(to) || !strlen(text)) return;

      GsmMgr.sendSms(to, text);

      uint8_t jIdx = doc["journal_idx"] | 255;
      if (jIdx < SmsLog.count()) {
        if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
          SmsLog.markReplied(jIdx);
          xSemaphoreGive(GsmMgr.dbMutex);
        }
      }
      publishEvent("{\"type\":\"cmd_result\",\"action\":\"send_sms\",\"ok\":true}");
    }

    // ── clear_sms_journal ─────────────────────────────────────
    else if (strcmp(action, "clear_sms_journal") == 0) {
      bool ok = false;
      if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        ok = SmsLog.clear();
        xSemaphoreGive(GsmMgr.dbMutex);
      }
      publishEvent(ok
        ? "{\"type\":\"cmd_result\",\"action\":\"clear_sms_journal\",\"ok\":true}"
        : "{\"type\":\"cmd_result\",\"action\":\"clear_sms_journal\",\"ok\":false}");
    }

    // ── get_gsm_status ────────────────────────────────────────
    else if (strcmp(action, "get_gsm_status") == 0) {
      GsmMgr.requestStatus();
    }

    // ── trigger_compaction ────────────────────────────────────
    else if (strcmp(action, "trigger_compaction") == 0) {
      GsmMgr.triggerCompaction();
      publishEvent("{\"type\":\"cmd_result\","
                   "\"action\":\"trigger_compaction\",\"ok\":true}");
    }

    // ── backup_db ─────────────────────────────────────────────
    // Бэкап ≤ ~3KB → base64 ~4KB → разбиваем на чанки по 384 байта
    else if (strcmp(action, "backup_db") == 0) {
      _sendBackup();
    }

    // ── restore_db_chunk ──────────────────────────────────────
    // {"action":"restore_db_chunk","seq":0,"total":N,"data":"base64..."}
    else if (strcmp(action, "restore_db_chunk") == 0) {
      _receiveRestoreChunk(doc);
    }
  }

  // ── Бэкап → base64 chunks в MQTT ─────────────────────────
  void _sendBackup() {
    class StringStream : public Stream {
    public:
      String buf;
      size_t write(uint8_t c) override { buf += (char)c; return 1; }
      size_t write(const uint8_t* b, size_t n) override {
        for (size_t i = 0; i < n; i++) buf += (char)b[i];
        return n;
      }
      int available() override { return 0; }
      int read()      override { return -1; }
      int peek()      override { return -1; }
    };

    StringStream ss;
    bool ok = false;
    if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
      ok = PhoneBook.backupToStream(ss);
      xSemaphoreGive(GsmMgr.dbMutex);
    }

    if (!ok) {
      publishEvent("{\"type\":\"backup_db\",\"ok\":false}");
      return;
    }

    String b64   = _toBase64(ss.buf);
    const size_t CHUNK = 384;
    uint8_t total = (uint8_t)((b64.length() + CHUNK - 1) / CHUNK);

    char topic[80];
    snprintf(topic, sizeof(topic), DEVICE_EVENTS_TMPL, cfg()->mqtt_user);

    for (uint8_t seq = 0; seq < total; seq++) {
      String chunk = b64.substring(seq * CHUNK,
                       min((size_t)((seq + 1) * CHUNK), b64.length()));
      String pkt = String("{\"type\":\"backup_db\",\"seq\":")
                 + seq + ",\"total\":" + total
                 + ",\"data\":\"" + chunk + "\"}";
      _mqtt.publish(topic, pkt.c_str(), false);
      delay(50);
    }
  }

  // ── Восстановление из чанков ──────────────────────────────
  void _receiveRestoreChunk(JsonDocument& doc) {
    static String  _buf;
    static uint8_t _total = 0;
    static uint8_t _recv  = 0;

    uint8_t     seq   = doc["seq"]   | 255;
    uint8_t     total = doc["total"] | 0;
    const char* data  = doc["data"]  | "";

    if (seq == 0) { _buf = ""; _total = total; _recv = 0; }

    if (seq != _recv) {
      _buf = ""; _total = 0; _recv = 0;
      publishEvent("{\"type\":\"cmd_result\",\"action\":\"restore_db\","
                   "\"ok\":false,\"err\":\"sequence_error\"}");
      return;
    }

    _buf += data;
    _recv++;
    if (_recv < _total) return;

    String binary = _fromBase64(_buf);
    _buf = "";

    class StrReadStream : public Stream {
    public:
      const String& src; size_t pos = 0;
      StrReadStream(const String& s) : src(s) {}
      int available() override { return src.length() - pos; }
      int read()      override { return pos < src.length() ? (uint8_t)src[pos++] : -1; }
      int peek()      override { return pos < src.length() ? (uint8_t)src[pos]   : -1; }
      size_t readBytes(char* b, size_t n) override {
        size_t r = min(n, src.length() - pos);
        memcpy(b, src.c_str() + pos, r); pos += r; return r;
      }
      size_t write(uint8_t) override { return 0; }
    };

    StrReadStream rs(binary);
    bool ok = false;
    if (xSemaphoreTake(GsmMgr.dbMutex, pdMS_TO_TICKS(2000)) == pdTRUE) {
      ok = PhoneBook.restoreFromStream(rs);
      xSemaphoreGive(GsmMgr.dbMutex);
    }

    publishEvent(ok
      ? "{\"type\":\"cmd_result\",\"action\":\"restore_db\",\"ok\":true}"
      : "{\"type\":\"cmd_result\",\"action\":\"restore_db\","
        "\"ok\":false,\"err\":\"restore_failed\"}");
  }

  // ── Утилиты ───────────────────────────────────────────────
  static uint64_t _phoneStrToUint64(const char* s) {
    char digits[16] = {0}; size_t di = 0;
    for (size_t i = 0; s[i] && di < 15; i++)
      if (isdigit((uint8_t)s[i])) digits[di++] = s[i];
    if (di == 11 && digits[0] == '8') digits[0] = '7';
    uint64_t r = 0;
    for (size_t i = 0; digits[i]; i++) r = r * 10 + (digits[i] - '0');
    return r;
  }

  static void _uint64ToPhoneStr(uint64_t num, char* buf, size_t sz) {
    if (num == 0) { strncpy(buf, "0", sz); return; }
    char tmp[16]; int len = 0;
    while (num > 0 && len < 15) { tmp[len++] = '0' + (num % 10); num /= 10; }
    for (int i = 0; i < len && i < (int)sz - 1; i++)
      buf[i] = tmp[len - 1 - i];
    buf[min(len, (int)sz - 1)] = '\0';
  }

  static String _toBase64(const String& in) {
    static const char* t =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    String out; size_t len = in.length();
    for (size_t p = 0; p < len; p += 3) {
      uint8_t b0=in[p], b1=p+1<len?in[p+1]:0, b2=p+2<len?in[p+2]:0;
      out+=t[b0>>2]; out+=t[((b0&3)<<4)|(b1>>4)];
      out+=(p+1<len)?t[((b1&0xf)<<2)|(b2>>6)]:'=';
      out+=(p+2<len)?t[b2&0x3f]:'=';
    }
    return out;
  }

  static String _fromBase64(const String& in) {
    static const String t =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    String out; size_t len = in.length();
    for (size_t p = 0; p + 3 < len; p += 4) {
      uint8_t b[4];
      for (int i=0;i<4;i++) b[i]=in[p+i]=='='?0:(uint8_t)t.indexOf(in[p+i]);
      out+=(char)((b[0]<<2)|(b[1]>>4));
      if (in[p+2]!='=') out+=(char)(((b[1]&0xf)<<4)|(b[2]>>2));
      if (in[p+3]!='=') out+=(char)(((b[2]&3)<<6)|b[3]);
    }
    return out;
  }

  #endif // GSM_VARIANT
};

extern MqttManager MqttMgr;
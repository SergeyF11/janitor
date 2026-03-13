#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"

#ifdef ESP32
  #include <LittleFS.h>
  #include <WiFi.h>
#else
  #include <LittleFS.h>
  #include <ESP8266WiFi.h>
#endif

class Crypto {
public:
  static void begin() {
    uint8_t mac[6];
    #ifdef ESP32
      esp_read_mac(mac, ESP_MAC_WIFI_STA);
    #else
      WiFi.macAddress(mac);
    #endif
    for (int i = 0; i < 32; i++)
      _key[i] = mac[i % 6] ^ CRYPTO_SALT[i % 16] ^ (uint8_t)(i * 7);
  }

  static String encrypt(const String& data) {
    String r = data;
    for (size_t i = 0; i < r.length(); i++) r[i] ^= _key[i % 32];
    return _toBase64(r);
  }

  static String decrypt(const String& data) {
    String r = _fromBase64(data);
    for (size_t i = 0; i < r.length(); i++) r[i] ^= _key[i % 32];
    return r;
  }

private:
  static uint8_t _key[32];

  static String _toBase64(const String& in) {
    static const char* b64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    String out;
    size_t len = in.length();
    for (size_t p = 0; p < len; p += 3) {
      uint8_t b0 = in[p], b1 = p+1<len ? in[p+1] : 0, b2 = p+2<len ? in[p+2] : 0;
      out += b64[b0 >> 2];
      out += b64[((b0&3)<<4)|(b1>>4)];
      out += p+1<len ? b64[((b1&0xf)<<2)|(b2>>6)] : '=';
      out += p+2<len ? b64[b2&0x3f] : '=';
    }
    return out;
  }

  static String _fromBase64(const String& in) {
    static const String b64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    String out;
    size_t len = in.length();
    for (size_t p = 0; p < len; p += 4) {
      uint8_t b[4];
      for (int i = 0; i < 4; i++)
        b[i] = in[p+i]=='=' ? 0 : (uint8_t)b64.indexOf(in[p+i]);
      out += (char)((b[0]<<2)|(b[1]>>4));
      if (in[p+2]!='=') out += (char)(((b[1]&0xf)<<4)|(b[2]>>2));
      if (in[p+3]!='=') out += (char)(((b[2]&3)<<6)|b[3]);
    }
    return out;
  }
};

class StorageManager {
public:
  bool begin() {
    if (!LittleFS.begin()) {
      LittleFS.format();
      if (!LittleFS.begin()) { Serial.println(F("[FS] Fatal")); return false; }
    }
    Serial.println(F("[FS] Mounted"));
    return true;
  }

  bool loadConfig(DeviceConfig& cfg) {
    _setDefaults(cfg);
    loadMainConfig(cfg);
    loadRelayConfig(cfg);
    return true;
  }

  bool saveConfig(const DeviceConfig& cfg) {
    return saveMainConfig(cfg) && saveRelayConfig(cfg);
  }

  bool loadMainConfig(DeviceConfig& cfg) {
    if (!LittleFS.exists(CONFIG_FILE)) return false;
    File f = LittleFS.open(CONFIG_FILE, "r");
    if (!f) return false;
    String json = Crypto::decrypt(f.readString());
    f.close();
    return _parseMain(json, cfg);
  }

  bool saveMainConfig(const DeviceConfig& cfg) {
    File f = LittleFS.open(CONFIG_FILE, "w");
    if (!f) return false;
    f.print(Crypto::encrypt(_serializeMain(cfg)));
    f.close();
    Serial.println(F("[FS] Main saved"));
    return true;
  }

  bool loadRelayConfig(DeviceConfig& cfg) {
    if (!LittleFS.exists(RELAY_FILE)) return false;
    File f = LittleFS.open(RELAY_FILE, "r");
    if (!f) return false;
    String json = Crypto::decrypt(f.readString());
    f.close();
    return _parseRelay(json, cfg);
  }

  bool saveRelayConfig(const DeviceConfig& cfg) {
    File f = LittleFS.open(RELAY_FILE, "w");
    if (!f) return false;
    f.print(Crypto::encrypt(_serializeRelay(cfg)));
    f.close();
    Serial.println(F("[FS] Relay saved"));
    return true;
  }

  void resetAll() {
    LittleFS.remove(CONFIG_FILE);
    LittleFS.remove(RELAY_FILE);
    Serial.println(F("[FS] All reset"));
  }

  void resetRegistration(DeviceConfig& cfg) {
    cfg.registered = false;
    memset(cfg.mqtt_host,    0, sizeof(cfg.mqtt_host));
    memset(cfg.mqtt_user,    0, sizeof(cfg.mqtt_user));
    memset(cfg.mqtt_pass,    0, sizeof(cfg.mqtt_pass));
    memset(cfg.registry_id,  0, sizeof(cfg.registry_id));
    memset(cfg.reg_code,     0, sizeof(cfg.reg_code));
    saveMainConfig(cfg);
    Serial.println(F("[FS] Registration reset"));
  }

  bool hasCert() { return LittleFS.exists(CERT_FILE); }

  bool loadCert(uint8_t** buf, size_t* len) {
    if (!hasCert()) return false;
    File f = LittleFS.open(CERT_FILE, "r");
    if (!f) return false;
    *len = f.size();
    *buf = new uint8_t[*len];
    f.read(*buf, *len);
    f.close();
    return true;
  }

private:
  void _setDefaults(DeviceConfig& cfg) {
    memset(&cfg, 0, sizeof(cfg));
    cfg.mqtt_port  = MQTT_PORT_TLS;
    cfg.tls_secure = false;
    cfg.registered = false;
    cfg.relays[0].pin        = 5;
    cfg.relays[0].active_low = true;
    strlcpy(cfg.relays[0].name, "relay1", sizeof(cfg.relays[0].name));
    for (uint8_t i = 1; i < MAX_RELAYS; i++)
      cfg.relays[i].pin = (uint8_t)NOT_A_PIN;
  }

  bool _parseMain(const String& json, DeviceConfig& cfg) {
    JsonDocument doc;
    if (deserializeJson(doc, json) != DeserializationError::Ok) return false;
    strlcpy(cfg.wifi1_ssid,   doc["w1s"] | "", sizeof(cfg.wifi1_ssid));
    strlcpy(cfg.wifi1_psk,    doc["w1p"] | "", sizeof(cfg.wifi1_psk));
    strlcpy(cfg.wifi2_ssid,   doc["w2s"] | "", sizeof(cfg.wifi2_ssid));
    strlcpy(cfg.wifi2_psk,    doc["w2p"] | "", sizeof(cfg.wifi2_psk));
    strlcpy(cfg.mqtt_host,    doc["mh"]  | "", sizeof(cfg.mqtt_host));
    cfg.mqtt_port = doc["mp"] | MQTT_PORT_TLS;
    strlcpy(cfg.mqtt_user,    doc["mu"]  | "", sizeof(cfg.mqtt_user));
    strlcpy(cfg.mqtt_pass,    doc["mps"] | "", sizeof(cfg.mqtt_pass));
    strlcpy(cfg.registry_id,  doc["rid"] | "", sizeof(cfg.registry_id));
    strlcpy(cfg.reg_code,     doc["rc"]  | "", sizeof(cfg.reg_code));
    cfg.registered = doc["reg"] | false;
    cfg.tls_secure = doc["tls"] | false;
    strlcpy(cfg.tz, doc["tz"] | "", sizeof(cfg.tz));
    return true;
  }

  String _serializeMain(const DeviceConfig& cfg) {
    JsonDocument doc;
    doc["w1s"] = cfg.wifi1_ssid;
    doc["w1p"] = cfg.wifi1_psk;
    doc["w2s"] = cfg.wifi2_ssid;
    doc["w2p"] = cfg.wifi2_psk;
    doc["mh"]  = cfg.mqtt_host;
    doc["mp"]  = cfg.mqtt_port;
    doc["mu"]  = cfg.mqtt_user;
    doc["mps"] = cfg.mqtt_pass;
    doc["rid"] = cfg.registry_id;
    doc["rc"]  = cfg.reg_code;
    doc["reg"] = cfg.registered;
    doc["tls"] = cfg.tls_secure;
    doc["tz"]  = cfg.tz;
    String out; serializeJson(doc, out);
    return out;
  }

  bool _parseRelay(const String& json, DeviceConfig& cfg) {
    JsonDocument doc;
    if (deserializeJson(doc, json) != DeserializationError::Ok) return false;
    for (uint8_t i = 0; i < MAX_RELAYS; i++)
      cfg.relays[i].pin = (uint8_t)NOT_A_PIN;
    for (JsonObject r : doc["rl"].as<JsonArray>()) {
      uint8_t idx = r["i"] | 255;
      if (idx >= MAX_RELAYS) continue;
      cfg.relays[idx].pin        = r["p"]  | (uint8_t)NOT_A_PIN;
      cfg.relays[idx].active_low = r["al"] | true;
      strlcpy(cfg.relays[idx].name, r["n"] | "relay", sizeof(cfg.relays[idx].name));
    }
    return true;
  }

  String _serializeRelay(const DeviceConfig& cfg) {
    JsonDocument doc;
    JsonArray arr = doc.createNestedArray("rl");
    for (uint8_t i = 0; i < MAX_RELAYS; i++) {
      if (!cfg.relays[i].isValid()) continue;
      JsonObject r = arr.createNestedObject();
      r["i"]  = i;
      r["p"]  = cfg.relays[i].pin;
      r["al"] = cfg.relays[i].active_low;
      r["n"]  = cfg.relays[i].name;
    }
    String out; serializeJson(doc, out);
    return out;
  }
};

extern StorageManager Storage;

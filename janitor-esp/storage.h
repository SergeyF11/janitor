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

// ── Простое XOR шифрование с ключом на основе MAC ─────────────
// AES требует сторонней библиотеки, используем XOR+key stretching
// Достаточно для защиты от чтения с флеш-памяти
class Crypto {
public:
  // Инициализация ключа из MAC адреса
  static void begin() {
    uint8_t mac[6];
    #ifdef ESP32
      esp_read_mac(mac, ESP_MAC_WIFI_STA);
    #else
      WiFi.macAddress(mac);
    #endif
    // Генерируем 32-байтный ключ из MAC + соли
    for (int i = 0; i < 32; i++) {
      _key[i] = mac[i % 6] ^ CRYPTO_SALT[i % 16] ^ (i * 7);
    }
  }

  // Шифрование/дешифрование (XOR симметричен)
  static String encrypt(const String& data) {
    String result = data;
    for (size_t i = 0; i < result.length(); i++) {
      result[i] ^= _key[i % 32];
    }
    return _toBase64(result);
  }

  static String decrypt(const String& data) {
    String decoded = _fromBase64(data);
    for (size_t i = 0; i < decoded.length(); i++) {
      decoded[i] ^= _key[i % 32];
    }
    return decoded;
  }

private:
  static uint8_t _key[32];

  static String _toBase64(const String& input) {
    const char* b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    String out;
    int i = 0;
    uint8_t buf[3];
    size_t len = input.length();
    for (size_t pos = 0; pos < len; pos += 3) {
      buf[0] = input[pos];
      buf[1] = (pos+1 < len) ? input[pos+1] : 0;
      buf[2] = (pos+2 < len) ? input[pos+2] : 0;
      out += b64[buf[0] >> 2];
      out += b64[((buf[0] & 3) << 4) | (buf[1] >> 4)];
      out += (pos+1 < len) ? b64[((buf[1] & 0xf) << 2) | (buf[2] >> 6)] : '=';
      out += (pos+2 < len) ? b64[buf[2] & 0x3f] : '=';
    }
    return out;
  }

  static String _fromBase64(const String& input) {
    const String b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    String out;
    size_t len = input.length();
    for (size_t pos = 0; pos < len; pos += 4) {
      uint8_t b[4];
      for (int i = 0; i < 4; i++) {
        b[i] = (input[pos+i] == '=') ? 0 : b64.indexOf(input[pos+i]);
      }
      out += (char)((b[0] << 2) | (b[1] >> 4));
      if (input[pos+2] != '=') out += (char)(((b[1] & 0xf) << 4) | (b[2] >> 2));
      if (input[pos+3] != '=') out += (char)(((b[2] & 3) << 6) | b[3]);
    }
    return out;
  }
};

// ── Менеджер хранилища ────────────────────────────────────────
class StorageManager {
public:
  bool begin() {
    if (!LittleFS.begin()) {
      Serial.println("[FS] LittleFS mount failed, formatting...");
      LittleFS.format();
      if (!LittleFS.begin()) {
        Serial.println("[FS] Fatal: cannot mount LittleFS");
        return false;
      }
    }
    Serial.println("[FS] LittleFS mounted");
    return true;
  }

  // Загрузить конфиг из файла
  bool loadConfig(DeviceConfig& cfg) {
    if (!LittleFS.exists(CONFIG_FILE)) {
      Serial.println("[FS] No config file, using defaults");
      _setDefaults(cfg);
      return false;
    }

    File f = LittleFS.open(CONFIG_FILE, "r");
    if (!f) return false;

    String encrypted = f.readString();
    f.close();

    String json = Crypto::decrypt(encrypted);
    Serial.println("[FS] Config loaded");
    Serial.println( json );

    return _parseJson(json, cfg);
  }

  // Сохранить конфиг в файл
  bool saveConfig(const DeviceConfig& cfg) {
    String json = _toJson(cfg);
    String encrypted = Crypto::encrypt(json);

    File f = LittleFS.open(CONFIG_FILE, "w");
    if (!f) return false;
    f.print(encrypted);
    f.close();

    Serial.println("[FS] Config saved");
    return true;
  }

  // Сбросить конфиг (удалить файл)
  void resetConfig() {
    LittleFS.remove(CONFIG_FILE);
    Serial.println("[FS] Config reset");
  }

  // Проверить наличие сертификата
  bool hasCert() {
    return LittleFS.exists(CERT_FILE);
  }

  // Сохранить сертификат (DER формат)
  bool saveCert(const uint8_t* data, size_t len) {
    File f = LittleFS.open(CERT_FILE, "w");
    if (!f) return false;
    f.write(data, len);
    f.close();
    Serial.printf("[FS] Certificate saved (%d bytes)\n", len);
    return true;
  }

  // Загрузить сертификат в X509List
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
    strlcpy(cfg.mqtt_host, SERVER_HOST, sizeof(cfg.mqtt_host));
    cfg.mqtt_port  = MQTT_PORT_TLS;
    cfg.tls_secure = false;
    cfg.registered = false;
    //cfg.relay_count = 1;
    cfg.relays[0].pin = 5;
    cfg.relays[0].active_low = true;
    strlcpy(cfg.relays[0].name, "Relay 1", sizeof(cfg.relays[0].name));
  }

  bool _parseJson(const String& json, DeviceConfig& cfg) {
    JsonDocument doc;
    if (deserializeJson(doc, json) != DeserializationError::Ok) {
      Serial.println("[FS] JSON parse error");
      _setDefaults(cfg);
      return false;
    }

    strlcpy(cfg.wifi1_ssid, doc["w1s"] | "", sizeof(cfg.wifi1_ssid));
    strlcpy(cfg.wifi1_psk,  doc["w1p"] | "", sizeof(cfg.wifi1_psk));
    strlcpy(cfg.wifi2_ssid, doc["w2s"] | "", sizeof(cfg.wifi2_ssid));
    strlcpy(cfg.wifi2_psk,  doc["w2p"] | "", sizeof(cfg.wifi2_psk));
    strlcpy(cfg.mqtt_host,  doc["mh"]  | SERVER_HOST, sizeof(cfg.mqtt_host));
    cfg.mqtt_port  = doc["mp"]  | MQTT_PORT_TLS;
    strlcpy(cfg.mqtt_user,  doc["mu"]  | "", sizeof(cfg.mqtt_user));
    strlcpy(cfg.mqtt_pass,  doc["mps"] | "", sizeof(cfg.mqtt_pass));
    cfg.registered = doc["reg"] | false;
    cfg.tls_secure = doc["tls"] | false;
    strlcpy(cfg.tz,  doc["tz"] | "", sizeof(cfg.tz));

    //cfg.relay_count = min((int)(doc["rc"] | 1), MAX_RELAYS);
    JsonArray relays = doc["rl"].as<JsonArray>();

    cfg.relay_count = 0;
    for (uint8_t i = 0; i < MAX_RELAYS /* cfg.relay_count */ && i < relays.size(); i++) {
      bool validRelay = relays[i]["p"];
      if( validRelay ) cfg.relay_count++;
      
      cfg.relays[i].pin        = relays[i]["p"]  | (uint8_t)NOT_A_PIN;
      cfg.relays[i].active_low = relays[i]["al"] | true;
      strlcpy(cfg.relays[i].name,       relays[i]["n"]  | "Relay", sizeof(cfg.relays[i].name));
      strlcpy(cfg.relays[i].mqtt_code,  relays[i]["c"]  | "",      sizeof(cfg.relays[i].mqtt_code));
    }
    //cfg.relayCount();
    return true;
  }

  String _toJson(const DeviceConfig& cfg) {
    // cfg.relayCount();
    JsonDocument doc;
    doc["w1s"] = cfg.wifi1_ssid;
    doc["w1p"] = cfg.wifi1_psk;
    doc["w2s"] = cfg.wifi2_ssid;
    doc["w2p"] = cfg.wifi2_psk;
    doc["mh"]  = cfg.mqtt_host;
    doc["mp"]  = cfg.mqtt_port;
    doc["mu"]  = cfg.mqtt_user;
    doc["mps"] = cfg.mqtt_pass;
    doc["reg"] = cfg.registered;
    doc["tls"] = cfg.tls_secure;
    //doc["rc"]  = cfg.relay_count;
    doc["tz"] = cfg.tz;

    JsonArray relays = doc.createNestedArray("rl");
   
    for (uint8_t i = 0; i < cfg.relay_count ; i++) {
      if ( cfg.relays[i].pin != (uint8_t)NOT_A_PIN ){
        JsonObject r = relays.createNestedObject();
        r["p"]  = cfg.relays[i].pin;
        r["al"] = cfg.relays[i].active_low;
        r["n"]  = cfg.relays[i].name;
        r["c"]  = cfg.relays[i].mqtt_code;
      }
    }

    String out;
    serializeJson(doc, out);

    Serial.println(out);
    return out;
  }
};

extern StorageManager Storage;
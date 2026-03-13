#pragma once
#include <Arduino.h>

#define FW_VERSION        "1.3.0"
#define DEVICE_PREFIX     "JANITOR"

#define AP_SSID_PREFIX    "Janitor-"
#define AP_PASSWORD       ""
#define PORTAL_TIMEOUT    300

#define SERVER_HOST       "smilart.ru"
#define SERVER_PORT       443
#define API_REGISTER      "/janitor/api/device/register"
#define MQTT_PORT_TLS     8883
#define MQTT_PORT_PLAIN   1883

#define CONFIG_FILE       "/config.json"
#define RELAY_FILE        "/relay.json"
#define CERT_FILE         "/cert.der"

#define CRYPTO_SALT       "JanitorSalt2024!"

#ifdef ESP32
  #define RESET_PIN RX
  #define LED_PIN         2
  #define LED_ACTIVE_LOW  false
#else
  #define RESET_PIN 3
  #define LED_PIN         LED_BUILTIN
  #define LED_ACTIVE_LOW  true
#endif

#define WIFI_TIMEOUT_MS       20000
#define MQTT_RECONNECT_MS     5000
#define NTP_TIMEOUT_MS        10000

#define NTP_SERVERS       "ru.pool.ntp.org","ntp.ix.ru","time.google.com"

#define MAX_RELAYS        4

// MQTT топики
// registry_id — заполняется при регистрации из ответа сервера
// mqtt_user   — YC device ID, используется для команд
#define DEVICE_CMD_TMPL    "$devices/%s/commands"      // ← команды: %s = mqtt_user (YC device ID)
#define DEVICE_EVENTS_TMPL "$registries/%s/events"     // → события:  %s = registry_id

// ── Реле ──────────────────────────────────────────────────────
struct RelayConfig {
  uint8_t pin;
  bool    active_low;
  char    name[64];

  bool isValid() const { return pin != (uint8_t)NOT_A_PIN; }
};

// ── Основной конфиг устройства ────────────────────────────────
struct DeviceConfig {
  // WiFi
  char wifi1_ssid[64];
  char wifi1_psk[64];
  char wifi2_ssid[64];
  char wifi2_psk[64];

  // MQTT — заполняется при регистрации
  char     mqtt_host[64];
  uint16_t mqtt_port;
  char     mqtt_user[64];   // YC device ID — для команд и clientId
  char     mqtt_pass[64];
  char     registry_id[32]; // YC registry ID — для публикации событий

  // Код привязки устройства
  char     reg_code[7];

  bool     registered;
  bool     tls_secure;
  char     tz[16];

  // Реле
  RelayConfig relays[MAX_RELAYS];

  uint8_t relayCount() const {
    uint8_t n = 0;
    for (uint8_t i = 0; i < MAX_RELAYS; i++)
      if (relays[i].isValid()) n++;
    return n;
  }

  bool hasPendingCode() const { return strlen(reg_code) == 6; }

  bool isRegistered() const {
    return registered && strlen(mqtt_host) > 0 &&
           strlen(mqtt_user) > 0 && strlen(registry_id) > 0;
  }

  void printTo(Stream& s) const {
    s.printf("WiFi: %s\n", wifi1_ssid);
    if (strlen(wifi2_ssid)) s.printf("WiFi2: %s\n", wifi2_ssid);
    s.printf("TZ: %s\n", tz);
    if (isRegistered()) {
      s.printf("MQTT: %s@%s:%u registry=%s\n",
        mqtt_user, mqtt_host, mqtt_port, registry_id);
    } else if (hasPendingCode()) {
      s.printf("Pending code: %s\n", reg_code);
    } else {
      s.println("Not registered, no code");
    }
    s.printf("TLS: %s | Relays: %u\n",
      tls_secure ? "secure" : "insecure", relayCount());
    for (uint8_t i = 0; i < MAX_RELAYS; i++) {
      if (!relays[i].isValid()) continue;
      s.printf("  [%u] pin=%u name=%s\n", i, relays[i].pin, relays[i].name);
    }
  }
};

enum DeviceState {
  STATE_PORTAL,
  STATE_CONNECTING,
  STATE_RUNNING,
  STATE_ERROR
};

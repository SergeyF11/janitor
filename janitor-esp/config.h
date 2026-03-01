#pragma once
#include <Arduino.h>

// ── Версия прошивки ───────────────────────────────────────────
#define FW_VERSION        "1.0.0"
#define DEVICE_PREFIX     "JANITOR"

// ── CaptivePortal ─────────────────────────────────────────────
#define AP_SSID_PREFIX    "Janitor-"   // + последние 4 символа MAC
#define AP_PASSWORD       ""           // открытая сеть
#define PORTAL_TIMEOUT    300          // сек, 0 = без таймаута

// ── Сервер ────────────────────────────────────────────────────
#define SERVER_HOST       "smilart.ru"
#define SERVER_PORT       443
#define API_REGISTER      "/janitor/api/device/register"
#define MQTT_PORT_TLS     8883
#define MQTT_PORT_PLAIN   1883

// ── LittleFS ──────────────────────────────────────────────────
#define CONFIG_FILE       "/config.json"
#define CERT_FILE         "/cert.der"

// ── Шифрование (AES-128-CBC) ──────────────────────────────────
// Ключ генерируется из MAC адреса устройства — уникален для каждого
#define CRYPTO_SALT       "JanitorSalt2024!"  // 16 байт

// ── LED ───────────────────────────────────────────────────────
#ifdef ESP32
  #define LED_PIN         2     // встроенный LED ESP32
  #define LED_ACTIVE_LOW  false
#else
  #define LED_PIN         LED_BUILTIN
  #define LED_ACTIVE_LOW  true  // ESP8266 — активный низкий
#endif

// ── Таймауты ──────────────────────────────────────────────────
#define WIFI_TIMEOUT_MS       20000   // 20 сек на подключение к WiFi
#define MQTT_RECONNECT_MS     5000    // пауза между попытками MQTT
#define HEARTBEAT_INTERVAL_MS 30000   // heartbeat каждые 30 сек
#define NTP_TIMEOUT_MS        10000   // таймаут синхронизации NTP

// ── NTP ───────────────────────────────────────────────────────
#define NTP_SERVER1       "pool.ntp.org"
#define NTP_SERVER2       "time.google.com"
//#define NTP_TIMEZONE      3           // UTC+3 (Москва)

// ── Реле ──────────────────────────────────────────────────────
#define MAX_RELAYS        4

// ── Структуры данных ──────────────────────────────────────────
struct RelayConfig {
  uint8_t  pin;
  bool     active_low;
  char     name[32];
  char     mqtt_code[7];   // 6-значный код привязки + \0
};

struct DeviceConfig {
  // WiFi
  char wifi1_ssid[64];
  char wifi1_psk[64];
  char wifi2_ssid[64];
  char wifi2_psk[64];

  // MQTT (заполняется после регистрации)
  char mqtt_host[64];
  uint16_t mqtt_port;
  char mqtt_user[64];
  char mqtt_pass[64];
  bool registered;          // true = уже прошли регистрацию

  // TLS
  bool tls_secure;          // true = проверять сертификат
  char tz[16];
  // Реле
  uint8_t relay_count;

  RelayConfig relays[MAX_RELAYS];
  uint8_t relayCount(){
    // for ( uint8_t i = 0; i < MAX_RELAYS; i++){
    //   if ( relays[i].pin == (uint8_t)NOT_A_PIN ) {
    //     relay_count = i;
    //     break;
    // }
    // return MAX_RELAYS;
    //uint8_t i = 0;
    relay_count = 0;
    while( relays[relay_count].pin != (uint8_t)NOT_A_PIN  ){
      relay_count++;
      if ( relay_count >= MAX_RELAYS) break;
    }
    return relay_count;
  };

  size_t printTo(Stream& p){
    size_t out;
    out = p.printf("WiFi: %s/%s\n", wifi1_ssid, wifi1_psk);
    if( strlen( wifi2_ssid)){
        out += p.printf("WiFi2: %s/%s\n", wifi2_ssid, wifi2_psk);
    }
    out += p.print("TZ: "); out += p.println(tz);
    out += p.print("MQTT: ");
    
    //auto relay_count = relayCount();
    if ( registered ){
        out += p.printf("%s:%s@%s:%u\n", mqtt_user, mqtt_pass, mqtt_host, mqtt_port);
    } else {
        
        for( uint8_t i = 0; i < relay_count; i++){
            if ( strlen( relays[i].mqtt_code ) == 6 ){
                out += p.printf( "Try reg code %s on %s:%u\n", relays[0].mqtt_code, mqtt_host, mqtt_port);
            }
        }
    }
    out += p.printf("TLS: %s\n", tls_secure ? "secure" : "insecure");
    out += p.printf("Relays %u\n", relay_count );
    return out;
  }
};

// ── Режимы работы устройства ──────────────────────────────────
enum DeviceState {
  STATE_PORTAL,       // CaptivePortal активен
  STATE_CONNECTING,   // Подключение WiFi/NTP
  STATE_RUNNING,      // Нормальная работа
  STATE_ERROR         // Ошибка подключения
};
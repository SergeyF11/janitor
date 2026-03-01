#pragma once
#include <Arduino.h>
#include "config.h"
#include "led.h"

#ifdef ESP32
  #include <WiFi.h>
  #include <time.h>
#else
  #include <ESP8266WiFi.h>
  #include <TZ.h>
  #include <sntp.h>
#endif

static constexpr time_t _2025_01_01_00_00_ = 1735689600LL;

class WiFiManager {
public:
  // Подключиться к WiFi (пробуем обе сети)
  bool connect(DeviceConfig& cfg) {
    Led.setMode( LedManager::CONNECTING);
    //_tz = cfg.tz;
    strncpy( _tz, cfg.tz, sizeof(_tz));
    // Пробуем основную сеть
    if (strlen(cfg.wifi1_ssid) > 0) {
      Serial.printf("[WiFi] Connecting to %s\n", cfg.wifi1_ssid);
      if (_tryConnect(cfg.wifi1_ssid, cfg.wifi1_psk)) return true;
    }

    // Пробуем резервную
    if (strlen(cfg.wifi2_ssid) > 0) {
      Serial.printf("[WiFi] Trying backup: %s\n", cfg.wifi2_ssid);
      if (_tryConnect(cfg.wifi2_ssid, cfg.wifi2_psk)) return true;
    }

    Serial.println("[WiFi] Connection failed");
    //Led.setError();
     Led.setMode( LedManager::ERROR);
    return false;
  }

  bool isConnected() {
    return WiFi.status() == WL_CONNECTED;
  }

  // Синхронизация времени (нужна для TLS)
 bool syncTime(bool required = true) {
    if ( _tz[0] == '\0' )
        configTime( 0, 0, NTP_SERVER1, NTP_SERVER2);
    else
        configTime( _tz,  NTP_SERVER1, NTP_SERVER2);
    
    if (!required) {
      // Без сертификата — просто запускаем NTP и не ждём
      //configTime(NTP_TIMEZONE * 3600, 0, NTP_SERVER1, NTP_SERVER2);

      Serial.println("[NTP] Started (not waiting, insecure mode)");
      return true;
    }

    Serial.println("[NTP] Syncing time (required for TLS)...");
    //configTime(0, 0, NTP_SERVER1, NTP_SERVER2);

    unsigned long start = millis();
    while (time(nullptr) < 1000000000UL) {  
      if (millis() - start > NTP_TIMEOUT_MS) {
        Serial.println("[NTP] Timeout!");
        return false;
      }
      Led.update();
      delay(100);
    }
    Serial.printf("[NTP] Synced: %lu\n", (unsigned long)time(nullptr));
    return true;
  }

  String getMac() {
    return WiFi.macAddress();
  }

  // Переподключение если потеряли сеть
  bool reconnectIfNeeded(DeviceConfig& cfg) {
    if (isConnected()) return true;
    Serial.println("[WiFi] Lost connection, reconnecting...");
    Led.setMode( LedManager::CONNECTING);
    return connect(cfg);
  }

private:
  char _tz[16];
  bool _tryConnect(const char* ssid, const char* psk) {
    WiFi.begin(ssid, psk);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED) {
      if (millis() - start > WIFI_TIMEOUT_MS) return false;
      Led.update();
      delay(50);
    }
    Serial.printf("[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
};

extern WiFiManager WifiMgr;
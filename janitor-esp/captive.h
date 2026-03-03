#pragma once
#include <Arduino.h>
#include <GyverPortal.h>
#include <LittleFS.h>
#include "config.h"
#include "storage.h"
#include "led.h"
#include "autoTime.h"

#ifdef ESP32
  #include <WiFi.h>
#else
  #include <ESP8266WiFi.h>
#endif

class CaptiveManager {
public:
  bool begin(DeviceConfig& cfg) {
    _ptr = this;
    _cfg = &cfg;
    String mac = WiFi.macAddress(); mac.replace(":", "");
    _apSSID = String(AP_SSID_PREFIX) + mac.substring(8);
    WiFi.mode(WIFI_AP);
    WiFi.softAP(_apSSID.c_str(), strlen(AP_PASSWORD) > 0 ? AP_PASSWORD : nullptr);
    Serial.printf("[Portal] AP: %s  IP: %s\n",
      _apSSID.c_str(), WiFi.softAPIP().toString().c_str());
    Led.setMode(LedManager::PORTAL);

    _portal.attachBuild(_buildPageP);
    _portal.attach(_handleActionP);
    _portal.enableOTA();

    #ifndef ESP32
      AutoTime::handler(_portal.server, NTP_SERVERS);
      EspTime::handler(_portal.server);
    #endif

    _portal.server.on("/upload_cert", HTTP_POST,
      []() {
        if (_ptr) {
          _ptr->_portal.server.sendHeader("Location", "/cert");
          _ptr->_portal.server.send(303);
        }
      },
      []() {
        if (!_ptr) return;
        HTTPUpload& upload = _ptr->_portal.server.upload();
        static File _certFile;
        if (upload.status == UPLOAD_FILE_START) {
          _certFile = LittleFS.open(CERT_FILE, "w");
        } else if (upload.status == UPLOAD_FILE_WRITE) {
          if (_certFile) _certFile.write(upload.buf, upload.currentSize);
        } else if (upload.status == UPLOAD_FILE_END) {
          if (_certFile) {
            _certFile.close();
            _ptr->_statusMsg = F("✅ Сертификат загружен (")
                             + String(upload.totalSize) + " б)";
            _ptr->_statusOk = true;
          }
        }
      }
    );

    _portal.start();
    Serial.println(F("[Portal] Started"));
    return true;
  }

  bool tick() {
    _portal.tick();
    Led.update();
    if (PORTAL_TIMEOUT > 0 && _cfg->isRegistered()) {
      if (millis() - _startTime > PORTAL_TIMEOUT * 1000UL) return true;
    }
    return _done;
  }

  void stop() {
    _portal.stop();
    WiFi.softAPdisconnect(true);
    Serial.println(F("[Portal] Stopped"));
  }

private:
  static CaptiveManager* _ptr;
  static void _buildPageP()    { if (_ptr) _ptr->_buildPage();    }
  static void _handleActionP() { if (_ptr) _ptr->_handleAction(); }

  GyverPortal   _portal;
  DeviceConfig* _cfg;
  String        _apSSID;
  bool          _done      = false;
  unsigned long _startTime = millis();
  String        _statusMsg;
  bool          _statusOk  = true;

  void _buildPage() {
    GP.BUILD_BEGIN(GP_DARK);
    GP.THEME(GP_DARK);
    GP.PAGE_TITLE("Привратник");

    GP.SEND(FPSTR(AutoTime::SCRIPT));
    GP.HIDDEN("tz", "");

    GP.NAV_TABS_LINKS("/",         "⚙️ WiFi");
    GP.NAV_TABS_LINKS("/relay",    "🔌 Реле");
    GP.NAV_TABS_LINKS("/register", "🔗 Привязка");
    GP.NAV_TABS_LINKS("/cert",     "🔒 Сертификат");
    GP.NAV_TABS_LINKS("/info",     "ℹ️ Инфо");

    if (_statusMsg.length() > 0) {
      _statusOk ? GP.ALERT("success", _statusMsg)
                : GP.ALERT("danger",  _statusMsg);
      _statusMsg = "";
    }

    String uri = *_gp_uri;

    // ── WiFi ─────────────────────────────────────────────────
    if (uri == "/" || uri == "") {
      GP.FORM_BEGIN("/save_wifi");
      GP.BLOCK_BEGIN();
      GP.TITLE("📶 WiFi");
      GP.LABEL("Основная сеть");
      GP.TEXT("w1s", "SSID", _cfg->wifi1_ssid);
      GP.PASS_EYE("w1p", "Пароль", _cfg->wifi1_psk);
      GP.LABEL("Резервная сеть");
      GP.TEXT("w2s", "SSID (необязательно)", _cfg->wifi2_ssid);
      GP.PASS_EYE("w2p", "Пароль", _cfg->wifi2_psk);
      GP.HR();
      GP.LABEL("TLS (проверять сертификат сервера)");
      GP.CHECK("tls", _cfg->tls_secure, GP_GREEN);
      GP.HR();
      GP.SUBMIT("💾 Сохранить WiFi");
      GP.BLOCK_END();
      GP.FORM_END();
    }

    // ── Реле ─────────────────────────────────────────────────
    else if (uri == "/relay") {
      GP.FORM_BEGIN("/save_relay");
      GP.BLOCK_BEGIN();
      GP.TITLE("🔌 Настройка реле");
      for (uint8_t i = 0; i < MAX_RELAYS; i++) {
        GP.HR();
        GP.TITLE("Реле " + String(i + 1));
        bool valid = _cfg->relays[i].isValid();
        GP.NUMBER("p"  + String(i), "GPIO пин (-1 = не используется)",
                  valid ? _cfg->relays[i].pin : -1);
        GP.LABEL("Активный LOW");
        GP.CHECK("al" + String(i), _cfg->relays[i].active_low, GP_GRAY);
        GP.TEXT("rn"  + String(i), "Название", _cfg->relays[i].name);
      }
      GP.HR();
      GP.SUBMIT("💾 Сохранить реле");
      GP.BLOCK_END();
      GP.FORM_END();
    }

    // ── Привязка ─────────────────────────────────────────────
    else if (uri == "/register") {
      GP.BLOCK_BEGIN();
      GP.TITLE("🔗 Привязка к серверу");

      if (_cfg->isRegistered()) {
        GP.ALERT("success",
          String(F("✅ Устройство привязано\n"))
          + "Сервер: " + _cfg->mqtt_host + "\n"
          + "Топик: "  + _cfg->mqtt_topic);
      } else {
        GP.ALERT("warning", F("⚠️ Устройство не привязано"));
      }

      GP.HR();

      // Реле
      if (_cfg->relayCount() == 0) {
        GP.ALERT("warning",
          F("⚠️ Нет настроенных реле. Сначала настройте реле на вкладке Реле."));
      } else {
        GP.LABEL("Реле на этом устройстве:");
        for (uint8_t i = 0; i < MAX_RELAYS; i++) {
          if (!_cfg->relays[i].isValid()) continue;
          GP.LABEL("  • Реле " + String(i+1) + " — " + String(_cfg->relays[i].name)
                   + " (пин " + String(_cfg->relays[i].pin) + ")");
        }
        GP.HR();
      }

      // Форма ввода кода (один код на всё устройство)
      if (!_cfg->isRegistered()) {
        GP.FORM_BEGIN("/save_code");
        GP.LABEL("Введите 6-значный код из панели администратора:");
        GP.TEXT("code", "Код привязки", _cfg->reg_code);
        GP.SUBMIT(_cfg->hasPendingCode()
          ? "✏️ Обновить код (привязка при перезагрузке)"
          : "🔗 Привязать устройство");
        GP.FORM_END();
      } else {
        GP.HR();
        GP.FORM_BEGIN("/reset_reg");
        GP.SUBMIT("🔓 Отвязать от сервера");
        GP.FORM_END();
      }

      GP.BLOCK_END();
    }

    // ── Сертификат ───────────────────────────────────────────
    else if (uri == "/cert") {
      GP.BLOCK_BEGIN();
      GP.TITLE("🔒 CA Сертификат");
      Storage.hasCert()
        ? GP.ALERT("success", F("✅ Сертификат загружен"))
        : GP.ALERT("warning", F("⚠️ Нет сертификата — Insecure mode"));
      GP.SEND(F(
        "<form method='POST' action='/upload_cert'"
        " enctype='multipart/form-data' style='margin:8px 0'>"
        "<label>Загрузить cert.der:</label><br><br>"
        "<input type='file' name='certfile' accept='.der'><br><br>"
        "<input type='submit' value='📤 Загрузить'"
        " style='padding:8px 16px;background:#1a4a7a;color:white;"
        "border:none;border-radius:6px;cursor:pointer'>"
        "</form>"
      ));
      if (Storage.hasCert()) {
        GP.HR();
        GP.FORM_BEGIN("/delete_cert");
        GP.SUBMIT("🗑️ Удалить сертификат");
        GP.FORM_END();
      }
      GP.BLOCK_END();
    }

    // ── Инфо ─────────────────────────────────────────────────
    else if (uri == "/info") {
      GP.BLOCK_BEGIN();
      GP.TITLE("ℹ️ Информация");
      GP.LABEL("Версия: "   + String(FW_VERSION));
      GP.LABEL("MAC: "      + WiFi.macAddress());
      GP.LABEL("AP SSID: "  + _apSSID);
      GP.LABEL("Heap: "     + String(ESP.getFreeHeap()) + " байт");
      GP.LABEL("Реле: "     + String(_cfg->relayCount()));
      GP.LABEL("Привязан: " + String(_cfg->isRegistered() ? "Да" : "Нет"));
      if (_cfg->isRegistered()) {
        GP.LABEL("Сервер: " + String(_cfg->mqtt_host));
        GP.LABEL("Топик: "  + String(_cfg->mqtt_topic));
      }
      GP.LABEL("TZ: " + String(EspTime::getTz() ? EspTime::getTz() : "—"));
      GP.SEND(FPSTR(EspTime::SCRIPT));
      GP.HR();
      GP.FORM_BEGIN("/reset_all");
      GP.SUBMIT("⚠️ Сбросить все настройки");
      GP.FORM_END();
      GP.HR();
      GP.FORM_BEGIN("/close");
      GP.SUBMIT("✅ Завершить настройку");
      GP.FORM_END();
      GP.BLOCK_END();
    }

    GP.BUILD_END();
  }

  void _handleAction() {

    if (_portal.form("/save_wifi")) {
      _portal.copyStr("w1s", _cfg->wifi1_ssid, sizeof(_cfg->wifi1_ssid));
      _portal.copyStr("w2s", _cfg->wifi2_ssid, sizeof(_cfg->wifi2_ssid));
      String p1 = _portal.getString("w1p");
      if (p1.length()) strlcpy(_cfg->wifi1_psk, p1.c_str(), sizeof(_cfg->wifi1_psk));
      String p2 = _portal.getString("w2p");
      if (p2.length()) strlcpy(_cfg->wifi2_psk, p2.c_str(), sizeof(_cfg->wifi2_psk));
      _cfg->tls_secure = _portal.getBool("tls");
      _saveTz();
      Storage.saveMainConfig(*_cfg);
      _statusMsg = F("✅ WiFi сохранён");  _statusOk = true;
    }

    if (_portal.form("/save_relay")) {
      for (uint8_t i = 0; i < MAX_RELAYS; i++) {
        String pinStr = _portal.getString("p" + String(i));
        int pinVal = pinStr.toInt();
        if (pinStr.isEmpty() || pinVal < 0) {
          _cfg->relays[i].pin = (uint8_t)NOT_A_PIN;
          continue;
        }
        _cfg->relays[i].pin        = (uint8_t)pinVal;
        _cfg->relays[i].active_low = _portal.getBool("al" + String(i));
        _portal.copyStr("rn" + String(i), _cfg->relays[i].name,
                        sizeof(_cfg->relays[i].name));
      }
      _saveTz();
      Storage.saveRelayConfig(*_cfg);
      _statusMsg = F("✅ Реле сохранены");  _statusOk = true;
    }

    if (_portal.form("/save_code")) {
      String code = _portal.getString("code");
      code.trim();
      if (code.length() == 6) {
        strlcpy(_cfg->reg_code, code.c_str(), sizeof(_cfg->reg_code));
        _saveTz();
        Storage.saveMainConfig(*_cfg);
        _statusMsg = F("✅ Код сохранён. Перезагрузите устройство для привязки.");
        _statusOk  = true;
      } else {
        _statusMsg = F("❌ Код должен содержать 6 цифр");
        _statusOk  = false;
      }
    }

    if (_portal.form("/reset_reg")) {
      Storage.resetRegistration(*_cfg);
      _statusMsg = F("🔓 Привязка сброшена");  _statusOk = true;
    }

    if (_portal.form("/delete_cert")) {
      LittleFS.remove(CERT_FILE);
      _statusMsg = F("🗑️ Сертификат удалён");  _statusOk = true;
    }

    if (_portal.form("/reset_all")) {
      Storage.resetAll();
      delay(300);
      ESP.restart();
    }

    if (_portal.form("/close")) {
      _done = true;
    }
  }

  void _saveTz() {
    const char* tz = EspTime::getTz();
    if (tz) strlcpy(_cfg->tz, tz, sizeof(_cfg->tz));
  }
};

extern CaptiveManager Portal;

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

    String mac = WiFi.macAddress();
    mac.replace(":", "");
    _apSSID = String(AP_SSID_PREFIX) + mac.substring(8);

    Serial.printf("[Portal] Starting AP: %s\n", _apSSID.c_str());
    WiFi.mode(WIFI_AP);
    WiFi.softAP(_apSSID.c_str(), strlen(AP_PASSWORD) > 0 ? AP_PASSWORD : nullptr);
    Serial.printf("[Portal] AP IP: %s\n", WiFi.softAPIP().toString().c_str());

    Led.setMode ( LedManager::PORTAL ); //Portal();

    _portal.attachBuild(_buildPageP);
    _portal.attach(_handleActionP);
    _portal.enableOTA();

    // AutoTime и EspTime обработчики
    #ifndef ESP32
      AutoTime::handler(_portal.server);
      EspTime::handler(_portal.server);
    #endif

    // Загрузка сертификата — отдельный upload handler
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
          Serial.println(F("[Portal] Cert upload start"));
          _certFile = LittleFS.open(CERT_FILE, "w");
        } else if (upload.status == UPLOAD_FILE_WRITE) {
          if (_certFile) _certFile.write(upload.buf, upload.currentSize);
        } else if (upload.status == UPLOAD_FILE_END) {
          if (_certFile) {
            _certFile.close();
            _ptr->_statusMsg = "✅ Сертификат загружен (" + String(upload.totalSize) + " б)";
            _ptr->_statusOk  = true;
            Serial.printf("[Portal] Cert saved: %d bytes\n", upload.totalSize);
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

    if (PORTAL_TIMEOUT > 0 && _cfg->registered) {
      if (millis() - _startTime > PORTAL_TIMEOUT * 1000UL) {
        Serial.println(F("[Portal] Timeout, closing"));
        return true;
      }
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

    // AutoTime — синхронизация времени и зоны из браузера
    //#ifndef ESP32
      GP.SEND(FPSTR(AutoTime::SCRIPT));
      GP.HIDDEN("tz", "");
    //#endif

    // Навигация
    GP.NAV_TABS_LINKS("/",         "⚙️ WiFi");
    GP.NAV_TABS_LINKS("/relay",    "🔌 Реле");
    GP.NAV_TABS_LINKS("/register", "🔗 Привязка");
    GP.NAV_TABS_LINKS("/cert",     "🔒 Сертификат");
    GP.NAV_TABS_LINKS("/info",     "ℹ️ Инфо");

    // Статусное сообщение
    if (_statusMsg.length() > 0) {
      _statusOk ? GP.ALERT("success", _statusMsg)
                : GP.ALERT("danger",  _statusMsg);
      _statusMsg = "";
    }

    String uri = *_gp_uri;

    // ── WiFi ──────────────────────────────────────────────
    if (uri == "/" || uri == "") {
      GP.FORM_BEGIN("/save_wifi");
      GP.BLOCK_BEGIN();
      GP.TITLE("📶 WiFi настройки");

      GP.LABEL("Основная сеть");
      GP.TEXT("w1s", "SSID", _cfg->wifi1_ssid);
      GP.PASS_EYE("w1p", "Пароль",  _cfg->wifi1_psk );

      GP.LABEL("Резервная сеть");
      GP.TEXT("w2s", "SSID (необязательно)", _cfg->wifi2_ssid);
      GP.PASS_EYE("w2p", "Пароль", _cfg->wifi2_psk );

      GP.HR();
      
      GP.SUBMIT("💾 Сохранить WiFi");
      GP.BLOCK_END();
      GP.FORM_END();
    }

    // ── Реле ──────────────────────────────────────────────
    else if (uri == "/relay") {
      GP.FORM_BEGIN("/save_relay");
      GP.BLOCK_BEGIN();
      GP.TITLE("🔌 Настройка реле");

      //GP.NUMBER("rc", "Количество реле (1-4)", _cfg->relay_count);

      for (uint8_t i = 0; i < MAX_RELAYS; i++) {
        GP.HR();
        GP.TITLE("Реле " + String(i+1));
        bool validRelay = _cfg->relays[i].pin != (uint8_t)NOT_A_PIN;

        GP.NUMBER("p" + String(i), "GPIO пин", _cfg->relays[i].pin);
                
        GP.LABEL("Активный LOW" );
        GP.CHECK("al" + String(i), _cfg->relays[i].active_low, GP_GRAY );

        String name = validRelay ? _cfg->relays[i].name : "";
        int sep = name.indexOf('|');
        if (sep >= 0) name = name.substring(0, sep);
        GP.TEXT("rn" + String(i), "Название", name);
      }

      GP.SUBMIT("💾 Сохранить реле");
      GP.BLOCK_END();
      GP.FORM_END();
    }

    // ── Привязка ──────────────────────────────────────────
    else if (uri == "/register") {
      GP.BLOCK_BEGIN();
      GP.TITLE("🔗 Привязка к серверу");

      GP.LABEL("MQTT сервер");
      GP.TEXT("mh", "Хост", _cfg->mqtt_host);
      GP.NUMBER("mp", "Порт", _cfg->mqtt_port);
      GP.HR();


      if (_cfg->registered) {
        GP.ALERT("success", "✅ Привязано. MQTT: " + String(_cfg->mqtt_user));
        GP.HR();
      }

      for (uint8_t i = 0; i < MAX_RELAYS/* _cfg->relay_count */; i++) {
        if ( ! _cfg->relays[i].isValid() ) continue;

        String name = _cfg->relays[i].name;
        int sep = name.indexOf('|');
        String dispName = sep >= 0 ? name.substring(0, sep) : name;
        String topic    = sep >= 0 ? name.substring(sep+1)  : "";

        String label = "Реле " + String(i+1);
        if (dispName.length()) label += " — " + dispName;
        if (topic.length())    label += " → " + topic;
        GP.LABEL(label);

        GP.FORM_BEGIN("/register_relay");
        GP.HIDDEN("ri", String(i));
        GP.TEXT("rc" + String(i), "6-значный код", _cfg->relays[i].mqtt_code);
        GP.SUBMIT("🔗 Привязать реле " + String(i+1));
        GP.FORM_END();
        GP.HR();
      }

      GP.BLOCK_END();
    }

    // ── Сертификат ────────────────────────────────────────
    else if (uri == "/cert") {
      
      GP.BLOCK_BEGIN();
      
      GP.TITLE("🔒 CA Сертификат");

      GP.LABEL("TLS режим");
      GP.CHECK("tls", _cfg->tls_secure, GP_GREEN);
      GP.HR();

      Storage.hasCert()
        ? GP.ALERT("success", "✅ Сертификат загружен")
        : GP.ALERT("warning", "⚠️ Нет сертификата — Insecure mode");

      // Нативный multipart form — GP.FILE_UPLOAD не работает надёжно
      GP.SEND(F(
        "<form method='POST' action='/upload_cert'"
        " enctype='multipart/form-data' style='margin:8px 0'>"
        "<label>Загрузить cert.der:</label><br><br>"
        "<input type='file' name='certfile' accept='.der'><br><br>"
        "<input type='submit' value='📤 Загрузить сертификат'"
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

    // ── Инфо ──────────────────────────────────────────────
    else if (uri == "/info") {
      GP.BLOCK_BEGIN();
      GP.TITLE("ℹ️ Информация");

      GP.LABEL("Версия: "   + String(FW_VERSION));
      GP.LABEL("MAC: "      + WiFi.macAddress());
      GP.LABEL("AP SSID: "  + _apSSID);
      GP.LABEL("Heap: "     + String(ESP.getFreeHeap()) + " байт");
      GP.LABEL("Привязан: " + String(_cfg->registered ? "Да" : "Нет"));

      if (_cfg->registered) {
        GP.LABEL("MQTT: " + String(_cfg->mqtt_host) + ":" + String(_cfg->mqtt_port));
        GP.LABEL("User: " + String(_cfg->mqtt_user));
      }

      // Часы из EspTime
      //#ifndef ESP32
      GP.LABEL("TZ: " + String( EspTime::getTz()));
      GP.SEND(FPSTR(EspTime::SCRIPT));
      //#endif

      GP.HR();
      GP.FORM_BEGIN("/reset");
      GP.SUBMIT("⚠️ Сбросить настройки");
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
      _portal.copyStr("mh",  _cfg->mqtt_host,  sizeof(_cfg->mqtt_host));

      String p1 = _portal.getString("w1p");
      if (p1.length() > 0) p1.toCharArray(_cfg->wifi1_psk, sizeof(_cfg->wifi1_psk));

      String p2 = _portal.getString("w2p");
      if (p2.length() > 0) p2.toCharArray(_cfg->wifi2_psk, sizeof(_cfg->wifi2_psk));

      _cfg->mqtt_port  = _portal.getInt("mp");
      _cfg->tls_secure = _portal.getBool("tls");
      //_cfg->tz = EspTime::getTz();
      strncpy( _cfg->tz, EspTime::getTz(), sizeof(_cfg->tz));
      Storage.saveConfig(*_cfg);
      _statusMsg = "✅ WiFi сохранён";  _statusOk = true;
      Serial.println(F("[Portal] WiFi saved"));
    }

    if (_portal.form("/save_relay")) {
      //_cfg->relay_count = constrain(_portal.getInt("rc"), 1, MAX_RELAYS);
      //_cfg->relayCount();
      for (uint8_t i = 0; i < MAX_RELAYS; i++) {
        _cfg->relays[i].pin        = _portal.getInt("p"  + String(i));
        _cfg->relays[i].active_low = _portal.getBool("al" + String(i));
        // Имя — сохраняем часть до | и добавляем топик после |
        String newName = _portal.getString("rn" + String(i));
        String cur = _cfg->relays[i].name;
        int sep = cur.indexOf('|');
        String full = newName + (sep >= 0 ? cur.substring(sep) : "");
        strlcpy(_cfg->relays[i].name, full.c_str(), sizeof(_cfg->relays[i].name));
        
      }
      strncpy( _cfg->tz, EspTime::getTz(), sizeof(_cfg->tz));
      // _cfg->relayCount();
      Storage.saveConfig(*_cfg);
      _statusMsg = "✅ Реле сохранены";  _statusOk = true;
    }

    if (_portal.form("/register_relay")) {
      uint8_t ri = _portal.getInt("ri");
      if (ri < MAX_RELAYS) {
        String code = _portal.getString("rc" + String(ri));
        code.trim();
        if (code.length() == 6) {
          code.toCharArray(_cfg->relays[ri].mqtt_code,
                           sizeof(_cfg->relays[ri].mqtt_code));

          strncpy( _cfg->tz, EspTime::getTz(), sizeof(_cfg->tz));                 
          Storage.saveConfig(*_cfg);
          _statusMsg = "✅ Код сохранён, привязка при перезагрузке";
          _statusOk  = true;
        } else {
          _statusMsg = "❌ Код должен содержать 6 цифр";
          _statusOk  = false;
        }
      }
    }

    if (_portal.form("/delete_cert")) {
      LittleFS.remove(CERT_FILE);
      _statusMsg = "🗑️ Сертификат удалён";  _statusOk = true;
    }

    if (_portal.form("/reset")) {
      Storage.resetConfig();
      delay(500);
      ESP.restart();
    }

    if (_portal.form("/close")) {

      _done = true;
    }
  }
};

//CaptiveManager* CaptiveManager::_ptr = nullptr;
extern CaptiveManager Portal;
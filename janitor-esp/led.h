#pragma once
#include <Arduino.h>
#include "config.h"

class LedManager {
public:
  void begin() {
    pinMode(LED_PIN, OUTPUT);
    setLed(false);
    _status = OFF;
  }

  // Вызывать в loop()
  void update() {
    //if (_mode == LED_SOLID) return;
    if ( _status == OFF || _status == ON ) return;
    
    unsigned long now = millis();
    if (now - _lastToggle < _intervalOn && _state) return;
    if (now - _lastToggle < _intervalOff && !_state) return;
    
    if (now - _lastToggle >= (_state ? _intervalOn : _intervalOff)) {
      _state = !_state;
      setLed(_state);
      _lastToggle = now;
    }
  }


  enum Status : uint8_t {
    OFF = 0,
    ON = 1,
    PORTAL = ON,
    CONNECTING = 2,
    RUNNING = 3,
    ERROR = 4
  };
  static const char* statusStr(const Status s){
    switch ( s ){
      case OFF: return "Off";
      case ON: return "On";
      //case PORTAL: return "Portal";
      case CONNECTING: return "Connecting";
      case RUNNING: return "Running";
      case ERROR: return "Error";
      default:
        return "Unknown";
    }
  };

  void setMode( const Status s ){
    if ( s == _status ) return;
    switch ( s ){
      case OFF:  setLed( false); break;
      case ON:  setLed( true); break;
      //case PORTAL: setPortal(); break;
      case CONNECTING: setConnecting(); break;
      case RUNNING: setRunning(); break;
      case ERROR: setError(); break;
      default:
        return;
    }
    _status = s;
    Serial.print("[LED] Change state ");
    Serial.println( statusStr(s));
  }
private:
  // enum LedMode { LED_SOLID, LED_BLINK };
  // LedMode _mode = LED_SOLID;
  Status  _status = OFF;
  bool _state = false;
  unsigned long _lastToggle = 0;
  unsigned long _intervalOn  = 500;
  unsigned long _intervalOff = 500;

  void setLed(bool on) {
    digitalWrite(LED_PIN, LED_ACTIVE_LOW ? !on : on);
  }

    // CaptivePortal — горит постоянно
  // void setPortal() {
  //   _mode = LED_SOLID;
  //   setLed(true);
  // }

  // Подключение — быстрое мигание 100мс
  void setConnecting() {
    //_mode = LED_BLINK;
    _intervalOn  = 100;
    _intervalOff = 100;
  }

  // Нормальная работа — вспышка 50мс / пауза 1с
  void setRunning() {
    //_mode = LED_BLINK;
    _intervalOn  = 24;
    _intervalOff = 1000;
  }

  // Ошибка — мигание 250/250мс
  void setError() {
    //_mode = LED_BLINK;
    _intervalOn  = 250;
    _intervalOff = 250;
  }

};

extern LedManager Led;
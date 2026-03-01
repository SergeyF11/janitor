#pragma once
#include <Arduino.h>
#include "config.h"


class RelayManager {
public:
  void begin(DeviceConfig& cfg) {
    //_count = cfg.relayCount(); //relay_count;
    for (uint8_t i = 0; i < MAX_RELAYS; i++) {
      _pins[i]      = cfg.relays[i].pin;
      bool validPin = cfg.relays[i].pin != (uint8_t)NOT_A_PIN;
      if( validPin ){      
        _activeLow[i] = cfg.relays[i].active_low;
        _state[i]     = false;
        pinMode(_pins[i], OUTPUT);
        setRelay(i, false);  // выключить при старте
      } 
    }
  }

  // Импульс (duration мс), затем выключить
  void pulse(uint8_t index, uint32_t duration) {
    if (index >= _count) return;
    setRelay(index, true);
    _pulseEnd[index] = millis() + duration;
    _pulsing[index]  = true;
  }

  // Переключить состояние (триггерный режим)
  bool toggle(uint8_t index) {
    if (index >= _count) return false;
    _state[index] = !_state[index];
    setRelay(index, _state[index]);
    return _state[index];
  }

  // Установить состояние напрямую
  void setState(uint8_t index, bool on) {
    if (index >= _count) return;
    _state[index] = on;
    setRelay(index, on);
  }

  bool getState(uint8_t index) {
    if (index >= _count) return false;
    return _state[index];
  }

  uint8_t getCount() { return _count; }

  // Вызывать в loop() — завершает импульсы
  void update() {
    unsigned long now = millis();
    for (uint8_t i = 0; i < _count; i++) {
      if (_pulsing[i] && now >= _pulseEnd[i]) {
        setRelay(i, false);
        _state[i]    = false;
        _pulsing[i]  = false;
      }
    }
  }

private:
  uint8_t  _count = 0;
  uint8_t  _pins[MAX_RELAYS];
  bool     _activeLow[MAX_RELAYS];
  bool     _state[MAX_RELAYS];
  bool     _pulsing[MAX_RELAYS]  = {false};
  unsigned long _pulseEnd[MAX_RELAYS] = {0};

  void setRelay(uint8_t i, bool on) {
    digitalWrite(_pins[i], _activeLow[i] ? !on : on);
  }
};

extern RelayManager Relays;
#pragma once
#include <Arduino.h>
#include "config.h"

class RelayManager {
public:
  void begin(DeviceConfig& cfg) {
    uint8_t j = 0;
    for (uint8_t i = 0; i < MAX_RELAYS; i++) {
      if (!cfg.relays[i].isValid()) continue;
      _pins[j]     = cfg.relays[i].pin;
      _activeLow[j]= cfg.relays[i].active_low;
      _cfgIndex[j] = i;   // запоминаем соответствие: relay[j] ↔ cfg.relays[i]
      _state[j]    = false;
      _pulsing[j]  = false;
      _pulseEnd[j] = 0;
      pinMode(_pins[j], OUTPUT);
      _setPin(j, false);
      Serial.printf("[RELAY] Init: manager[%u] = cfg[%u] pin=%u %s\n",
        j, i, _pins[j], _activeLow[j] ? "active_low" : "active_high");
      j++;
    }
    _count = j;
  }

  // Импульс (duration мс)
  void pulse(uint8_t idx, uint32_t duration) {
    if (idx >= _count) return;
    _setPin(idx, true);
    _state[idx]   = true;
    _pulseEnd[idx]= millis() + duration;
    _pulsing[idx] = true;
  }

  // Установить состояние
  void setState(uint8_t idx, bool on) {
    if (idx >= _count) return;
    _state[idx] = on;
    _setPin(idx, on);
  }

  bool getState(uint8_t idx) const {
    return idx < _count ? _state[idx] : false;
  }

  uint8_t getCount() const { return _count; }

  // Получить config index для relay manager index
  uint8_t getCfgIndex(uint8_t idx) const {
    return idx < _count ? _cfgIndex[idx] : 255;
  }

  // Найти relay manager index по config index (-1 если не найден)
  int8_t findByCfgIndex(uint8_t cfgIdx) const {
    for (uint8_t i = 0; i < _count; i++)
      if (_cfgIndex[i] == cfgIdx) return (int8_t)i;
    return -1;
  }

  // Вызывать в loop() — завершение импульсов
  // Возвращает битовую маску реле, у которых изменилось состояние
  uint8_t update() {
    uint8_t changed = 0;
    unsigned long now = millis();
    for (uint8_t i = 0; i < _count; i++) {
      if (_pulsing[i] && now >= _pulseEnd[i]) {
        _setPin(i, false);
        _state[i]   = false;
        _pulsing[i] = false;
        changed |= (1 << i);
      }
    }
    return changed;
  }

private:
  uint8_t  _count = 0;
  uint8_t  _pins[MAX_RELAYS];
  bool     _activeLow[MAX_RELAYS];
  uint8_t  _cfgIndex[MAX_RELAYS];   // relay manager index → config index
  bool     _state[MAX_RELAYS];
  bool     _pulsing[MAX_RELAYS];
  unsigned long _pulseEnd[MAX_RELAYS];

  void _setPin(uint8_t i, bool on) {
    Serial.printf("[RELAY] pin=%u -> %s\n", _pins[i], on ? "ON" : "OFF");
    digitalWrite(_pins[i], _activeLow[i] ? !on : on);
  }
};

extern RelayManager Relays;

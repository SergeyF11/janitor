'use strict'
// ── MQTT Provider factory ─────────────────────────────────────
// MQTT_PROVIDER=local    — свой Mosquitto (по умолчанию)
// MQTT_PROVIDER=yandex   — Yandex IoT Core

const PROVIDER = (process.env.MQTT_PROVIDER || 'local').toLowerCase()

let provider
if (PROVIDER === 'yandex') {
  provider = require('./providers/yandex')
  console.log('[mqtt] Provider: Yandex IoT Core')
} else {
  provider = require('./providers/local')
  console.log('[mqtt] Provider: Local Mosquitto')
}

module.exports = provider


#!/bin/sh
set -e

CONFIG_DIR=/mosquitto/config
DYNSEC_FILE=$CONFIG_DIR/dynsec.json

# Инициализируем dynsec если файла нет
if [ ! -f "$DYNSEC_FILE" ]; then
    echo "[init] Creating dynsec config..."
    mosquitto_ctrl dynsec init $DYNSEC_FILE "$MQTT_USER" <<PASS
$MQTT_PASS
$MQTT_PASS
PASS
    chown mosquitto:mosquitto "$DYNSEC_FILE"
    chmod 644 "$DYNSEC_FILE"
    echo "[init] dynsec initialized"
fi

# Запускаем mosquitto
exec mosquitto -c /mosquitto/config/mosquitto.conf

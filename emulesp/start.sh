#!/bin/bash

# Название файла с кодом эмулятора
SCRIPT_NAME="emul.js"
CREDS=".esp-creds.json"

# Проверка: передан ли токен
if [ -z "$1" ] && [ ! -f "${CREDS}" ]; then
    echo "Ошибка: Не указан код устройства!"
    echo "Использование: ./start_emulator.sh <ваш_код_из_интерфейса>"
    exit 1
fi

# Установка зависимостей, если их еще нет
if [ ! -d "node_modules" ]; then
    echo "Установка зависимостей (mqtt, node-fetch)..."
    npm install mqtt node-fetch
fi

# Проверка наличия самого JS-файла
if [ ! -f "$SCRIPT_NAME" ]; then
    echo "Ошибка: Файл $SCRIPT_NAME не найден в текущей директории."
    exit 1
fi

# Запуск
echo "Запуск эмулятора..."
node "$SCRIPT_NAME" "$1"

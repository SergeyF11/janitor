# Руководство по развертыванию (DevOps)

## 1. Требования

- Сервер Linux (Ubuntu 20.04+), минимум 2 CPU, 2 GB RAM
- Установленные Docker и Docker Compose
- Git
- Доступ в интернет
- Аккаунт в Yandex Cloud с созданным реестром устройств (IoT Core)
- Сертификаты для MQTT (CA, клиентский сертификат и ключ)

## 2. Подготовка Yandex Cloud

1. Создайте **реестр устройств** в Yandex IoT Core, запомните его ID.
2. Создайте **сервисный аккаунт** с ролью `iot.devices.writer` и сгенерируйте авторизованный ключ (JSON-файл). Этот файл потребуется для управления устройствами.
3. Скачайте корневой сертификат CA Yandex Cloud (например, `CA.pem`) и создайте клиентские сертификаты для сервера (или используйте готовые).

## 3. Подготовка сервера

### Установка Docker и Docker Compose

```bash
sudo apt update
sudo apt install docker.io docker-compose -y
sudo systemctl enable docker
sudo usermod -aG docker $USER
# Перезайдите или выполните newgrp docker
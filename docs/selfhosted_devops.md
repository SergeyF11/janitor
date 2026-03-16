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
```

### Клонирование репозитория

```bash
git clone <URL репозитория> /opt/janitor
cd /opt/janitor
```

### Структура сертификатов

```bash
mkdir -p /opt/janitor/certs
# Скопируйте в эту папку:
#   - sa-key.json (ключ сервисного аккаунта)
#   - client.crt
#   - client.key
#   - CA.pem
chmod 600 /opt/janitor/certs/*.key
```

## 4. Конфигурация

Создайте файл .env в корне проекта:

``` bash
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# База данных (PostgreSQL)
DB_HOST=postgres
DB_PORT=5432
DB_NAME=janitor
DB_USER=janitor
DB_PASSWORD=strong_password
DB_SSL=false

# JWT
JWT_SECRET=your_strong_jwt_secret_here

# Yandex Cloud
YC_REGISTRY_ID=your_registry_id
YC_SA_KEY_FILE=/app/certs/sa-key.json
MQTT_HOST=mqtt.cloud.yandex.net
MQTT_PORT=8883
MQTT_CERT_FILE=/app/certs/client.crt
MQTT_KEY_FILE=/app/certs/client.key
MQTT_CA_FILE=/app/certs/CA.pem

# CORS (для продакшена укажите конкретный домен)
CORS_ORIGIN=true

# Суперадмин
SUPERADMIN_LOGIN=superadmin
SUPERADMIN_PASSWORD=very_strong_password

# Миграции (при первом запуске = true)
RUN_MIGRATIONS=true
```

## 5. Docker Compose

``` yaml
version: '3.8'

services:
  postgres:
    image: postgres:15
    container_name: janitor-postgres
    restart: always
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    build: .
    container_name: janitor-backend
    restart: always
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=${NODE_ENV}
      - PORT=${PORT}
      - HOST=${HOST}
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_NAME=${DB_NAME}
      - DB_USER=${DB_USER}
      - DB_PASSWORD=${DB_PASSWORD}
      - DB_SSL=${DB_SSL}
      - JWT_SECRET=${JWT_SECRET}
      - YC_REGISTRY_ID=${YC_REGISTRY_ID}
      - YC_SA_KEY_FILE=${YC_SA_KEY_FILE}
      - MQTT_HOST=${MQTT_HOST}
      - MQTT_PORT=${MQTT_PORT}
      - MQTT_CERT_FILE=${MQTT_CERT_FILE}
      - MQTT_KEY_FILE=${MQTT_KEY_FILE}
      - MQTT_CA_FILE=${MQTT_CA_FILE}
      - CORS_ORIGIN=${CORS_ORIGIN}
      - SUPERADMIN_LOGIN=${SUPERADMIN_LOGIN}
      - SUPERADMIN_PASSWORD=${SUPERADMIN_PASSWORD}
      - RUN_MIGRATIONS=${RUN_MIGRATIONS}
    volumes:
      - ./certs:/app/certs:ro
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  pg_data:
```

## 6. Запуск

``` bash
docker-compose up -d
```
Проверьте логи:

``` bash
docker-compose logs -f backend
```

При первом запуске с RUN_MIGRATIONS=true база данных инициализируется. После успешного запуска установите RUN_MIGRATIONS=false и перезапустите контейнер.

## 7. Проверка
Откройте браузер и перейдите по адресу http://ваш-сервер:3000/janitor/. Должна открыться страница входа.

## 8. Обновление

``` bash
docker-compose down
git pull
docker-compose build
docker-compose up -d
```

Если изменилась структура БД, временно установите RUN_MIGRATIONS=true и перезапустите, затем верните false.

## 9. Резервное копирование
``` bash
docker exec janitor-postgres pg_dump -U janitor janitor > backup_$(date +%Y%m%d).sql
```

Храните бэкапы в надёжном месте.
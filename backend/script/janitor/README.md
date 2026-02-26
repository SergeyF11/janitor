# Janitor — Система управления реле

## Быстрый старт

### Шаг 1 — Скопировать файлы на сервер

```bash
scp -r ./janitor root@smilart.ru:/opt/janitor
```

Или на сервере:
```bash
mkdir -p /opt/janitor
# ... скопировать файлы проекта
```

### Шаг 2 — Запустить setup

```bash
cd /opt/janitor
chmod +x setup.sh
sudo bash setup.sh
```

Скрипт:
- Создаст структуру директорий
- Сгенерирует секреты в .env
- Создаст MQTT passwd файл
- Установит nginx конфиг

### Шаг 3 — Проверить .env

```bash
nano /opt/janitor/.env
```

Обязательно установить:
- `SUPERADMIN_PASSWORD` — пароль суперадмина

### Шаг 4 — Добавить volume в smilart.yaml

В `/opt/smilart-services/smilart.yaml` в секцию `nginx → volumes` добавить:

```yaml
- "/opt/janitor/nginx/janitor.conf:/etc/nginx/conf.d/janitor.conf:ro"
```

Затем пересоздать nginx контейнер:
```bash
cd /opt/smilart-services
docker compose up -d --force-recreate nginx
```

### Шаг 5 — Запустить сервисы

```bash
cd /opt/janitor
docker compose up -d

# Следить за запуском
docker compose logs -f
```

### Шаг 6 — Проверка

```bash
# Health check
curl https://smilart.ru/janitor/health

# Статус контейнеров
docker compose ps

# Логи backend
docker compose logs backend --tail 50
```

---

## Структура сервиса

```
https://smilart.ru/janitor/          — PWA приложение
https://smilart.ru/janitor/api/      — REST API
wss://smilart.ru/janitor/ws          — WebSocket
mqtt://smilart.ru:8883               — MQTT TLS (ESP устройства)
```

## Управление

```bash
# Остановить
docker compose down

# Обновить backend
docker compose build backend
docker compose up -d backend

# Бэкап БД
docker exec janitor-postgres pg_dump -U janitor janitor > backup.sql

# Посмотреть логи
docker compose logs -f --tail 100
```

## Добавить устройство ESP

После регистрации устройства через API, добавить его MQTT учётные данные:

```bash
cd /opt/janitor
# Добавить строку в mosquitto passwd
docker run --rm eclipse-mosquitto:2 \
  mosquitto_passwd -b mosquitto/config/passwd device_AABBCCDDEEFF ПАРОЛЬ

# Перезагрузить mosquitto (без разрыва соединений)
docker exec janitor-mosquitto mosquitto_reload 2>/dev/null || \
docker compose restart janitor-mosquitto
```

## Порты

| Порт | Сервис | Видимость |
|------|--------|-----------|
| 443 | HTTPS (nginx→Caddy) | наружу |
| 8883 | MQTT TLS | наружу |
| 3000 | Backend | только внутри Docker |
| 5432 | PostgreSQL | только внутри Docker |
| 6379 | Redis | только внутри Docker |
| 1883 | MQTT plain | только внутри Docker |

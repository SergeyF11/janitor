#!/bin/bash
# ──────────────────────────────────────────────────────────────────
# Janitor — скрипт первоначальной настройки
# Запускать: sudo bash setup.sh
# ──────────────────────────────────────────────────────────────────
set -e

PROJECT_DIR="/opt/janitor"
SMILART_DIR="/opt/smilart-services"
CERT_BASE="/opt/smilart-services/caddy/certificates/acme-v02.api.letsencrypt.org-directory/smilart.ru"

echo "======================================"
echo " Janitor Setup"
echo "======================================"

# ── 1. Создать структуру директорий ───────────────────────────────
echo "[1/7] Creating directories..."
mkdir -p "$PROJECT_DIR"/{backend/src,mosquitto/{config,data,log},postgres/data,redis/data,nginx}

# ── 2. Проверить сертификаты Caddy ────────────────────────────────
echo "[2/7] Checking SSL certificates..."
if [ ! -f "$CERT_BASE/smilart.ru.crt" ]; then
  echo "ERROR: Certificate not found at $CERT_BASE/smilart.ru.crt"
  echo "Make sure Caddy (https-proxy) has obtained the certificate first."
  exit 1
fi
echo "  OK: $CERT_BASE/smilart.ru.crt"

# ── 3. Создать .env если не существует ────────────────────────────
echo "[3/7] Setting up .env..."
if [ ! -f "$PROJECT_DIR/.env" ]; then
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  
  # Автогенерация секретов
  POSTGRES_PASS=$(openssl rand -hex 24)
  REDIS_PASS=$(openssl rand -hex 24)
  JWT_SECRET=$(openssl rand -hex 64)
  JWT_REFRESH=$(openssl rand -hex 64)
  MQTT_PASS=$(openssl rand -hex 24)
  
  sed -i "s/REPLACE_WITH_STRONG_PASSWORD/$POSTGRES_PASS/" "$PROJECT_DIR/.env"
  sed -i "s/REPLACE_WITH_STRONG_PASSWORD/$REDIS_PASS/" "$PROJECT_DIR/.env"
  sed -i "s/REPLACE_WITH_64_HEX_CHARS/$JWT_SECRET/" "$PROJECT_DIR/.env"
  sed -i "s/REPLACE_WITH_ANOTHER_64_HEX_CHARS/$JWT_REFRESH/" "$PROJECT_DIR/.env"
  
  echo ""
  echo "  !! .env created with auto-generated secrets."
  echo "  !! SET YOUR SUPERADMIN PASSWORD in $PROJECT_DIR/.env before continuing!"
  echo "  !! Edit: nano $PROJECT_DIR/.env"
  echo ""
  read -p "  Press Enter when ready to continue..."
else
  echo "  .env already exists, skipping"
fi

# ── 4. Создать пароль для MQTT admin ──────────────────────────────
echo "[4/7] Creating MQTT password file..."
if [ ! -f "$PROJECT_DIR/mosquitto/config/passwd" ]; then
  source "$PROJECT_DIR/.env"
  # Создаём временный контейнер для генерации passwd
  docker run --rm eclipse-mosquitto:2 \
    sh -c "mosquitto_passwd -b -c /tmp/passwd $MQTT_ADMIN_USER $MQTT_ADMIN_PASSWORD && cat /tmp/passwd" \
    > "$PROJECT_DIR/mosquitto/config/passwd"
  chmod 600 "$PROJECT_DIR/mosquitto/config/passwd"
  echo "  OK: MQTT passwd created"
else
  echo "  MQTT passwd already exists, skipping"
fi

# ── 5. Права на директории mosquitto ──────────────────────────────
echo "[5/7] Setting permissions..."
chmod -R 755 "$PROJECT_DIR/mosquitto/data"
chmod -R 755 "$PROJECT_DIR/mosquitto/log"
# Mosquitto запускается от UID 1883
chown -R 1883:1883 "$PROJECT_DIR/mosquitto/data" "$PROJECT_DIR/mosquitto/log" 2>/dev/null || true

# ── 6. Добавить janitor.conf в nginx ──────────────────────────────
echo "[6/7] Installing nginx config..."
NGINX_CONF="/etc/nginx/conf.d/janitor.conf"
if [ ! -f "$NGINX_CONF" ]; then
  cp "$PROJECT_DIR/nginx/janitor.conf" "$NGINX_CONF"
  echo "  OK: $NGINX_CONF installed"
  
  # Проверить конфиг nginx
  docker exec nginx nginx -t && echo "  OK: nginx config test passed"
else
  echo "  nginx janitor.conf already exists"
fi

# ── 7. Итог ───────────────────────────────────────────────────────
echo ""
echo "======================================"
echo " Setup complete!"
echo "======================================"
echo ""
echo "Next steps:"
echo "  1. Check .env:          nano $PROJECT_DIR/.env"
echo "  2. Start services:      cd $PROJECT_DIR && docker compose up -d"
echo "  3. Check logs:          docker compose logs -f backend"
echo "  4. Reload nginx:        docker exec nginx nginx -s reload"
echo "  5. Test health:         curl https://smilart.ru/janitor/health"
echo ""

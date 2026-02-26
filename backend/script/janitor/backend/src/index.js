'use strict'

const path = require('path')
require('dotenv').config()

const { buildApp } = require('./app')
const { initDb, runMigrations } = require('./db/migrate')
const { initMqtt } = require('./mqtt/client')
const { ensureSuperAdmin } = require('./services/auth.service')

const PORT = parseInt(process.env.PORT || '3000')
const HOST = '0.0.0.0'

async function main() {
  console.log('[boot] Starting Janitor backend...')

  // 1. БД — миграции и суперадмин
  await initDb()
  await runMigrations()
  await ensureSuperAdmin()

  // 2. MQTT клиент
  await initMqtt()

  // 3. Fastify приложение
  const app = await buildApp()

  try {
    await app.listen({ port: PORT, host: HOST })
    console.log(`[boot] Server listening on ${HOST}:${PORT}`)
    console.log(`[boot] Base path: ${process.env.BASE_PATH || '/janitor'}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('[boot] Fatal error:', err)
  process.exit(1)
})

'use strict'
const postgres = require('postgres')

let db = null

/**
 * Получить имя целевой базы данных из конфигурации
 */
function getTargetDbName() {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL)
    return url.pathname.slice(1) // удаляем ведущий слеш
  }
  return process.env.DB_NAME || 'janitor'
}

/**
 * Подключиться к системной базе (postgres) и выполнить SQL
 */
async function withSystemDb(callback) {
  const connectionString = process.env.DATABASE_URL
  let systemDb

  if (connectionString) {
    const url = new URL(connectionString)
    url.pathname = '/postgres' // переключаемся на системную БД
    systemDb = postgres(url.toString(), { max: 1 })
  } else {
    systemDb = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: 'postgres',
      username: process.env.DB_USER || 'janitor',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 1
    })
  }

  try {
    return await callback(systemDb)
  } finally {
    await systemDb.end()
  }
}

/**
 * Создать целевую базу данных, если она не существует
 */
async function ensureDatabaseExists() {
  const targetDbName = getTargetDbName()

  await withSystemDb(async (sql) => {
    // Проверяем существование БД
    const [result] = await sql`
      SELECT 1 FROM pg_database WHERE datname = ${targetDbName}
    `
    if (!result) {
      console.log(`[db] Database "${targetDbName}" does not exist, creating...`)
      await sql`CREATE DATABASE ${sql(targetDbName)}`
      console.log(`[db] Database "${targetDbName}" created.`)
    } else {
      console.log(`[db] Database "${targetDbName}" already exists.`)
    }
  })
}

async function initDb() {

  await ensureDatabaseExists()
  // Поддерживает как DATABASE_URL так и отдельные параметры
  // При переносе на Yandex — просто меняем DATABASE_URL в .env
  const connectionString = process.env.DATABASE_URL

  const options = connectionString ? { max: 10 } : {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'janitor',
    username: process.env.DB_USER     || 'janitor',
    password: process.env.DB_PASSWORD || '',
    max:      10,
    // Yandex Managed PostgreSQL требует SSL
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  }

  db = connectionString
    ? postgres(connectionString, options)
    : postgres(options)

  // Проверить соединение
  await db`SELECT 1`
  console.log('[db] Connected')
  return db
}

function getDb() {
  if (!db) throw new Error('DB not initialized. Call initDb() first.')
  return db
}

module.exports = { initDb, getDb }
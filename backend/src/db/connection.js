'use strict'
const postgres = require('postgres')

let db = null

async function initDb() {
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
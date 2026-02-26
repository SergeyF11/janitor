'use strict'

const postgres = require('postgres')

let db

function getDb() {
  if (!db) {
    db = postgres(process.env.DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {}
    })
  }
  return db
}

module.exports = { getDb }

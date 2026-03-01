'use strict'
require('dotenv').config()
const { buildApp } = require('./app')

const PORT = parseInt(process.env.PORT || '3000')
const HOST = process.env.HOST || '0.0.0.0'

buildApp()
  .then(app => app.listen({ port: PORT, host: HOST }))
  .then(() => console.log(`[server] Listening on ${HOST}:${PORT}`))
  .catch(err => {
    console.error('[server] Fatal error:', err)
    process.exit(1)
  })
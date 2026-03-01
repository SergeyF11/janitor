'use strict'

async function healthRoutes(app) {
  app.get('/health', async (req, reply) => {
    return { status: 'ok', ts: new Date().toISOString() }
  })
}

module.exports = healthRoutes

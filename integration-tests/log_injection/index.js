'use strict'

const options = {
  service: 'test-service',
  sampleRate: 0.0,
  samplingRules: [
    {
      resource: 'GET /sampled',
      sampleRate: 1.0
    }
  ]
}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.lOG_INJECTION) {
  options.logInjection = process.env.lOG_INJECTION
}

const tracer = require('dd-trace')
tracer.init(options)

const express = require('express')
const winston = require('winston')

const app = express()

// Create winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({ silent: true })
  ]
})

// Route WITH logging (demonstrates the bug)
app.get('/sampled', (req, res) => {
  // BUG: This winston.info() triggers log injection BEFORE resource.name is set
  // which causes sampling decision to happen too early, bypassing the resource rule
  logger.info('Processing GET /sampled request')
  res.json({ message: 'logged request' })
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})

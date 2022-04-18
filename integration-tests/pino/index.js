'use strict'

const options = {}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.AGENT_URL) {
  options.url = process.env.AGENT_URL
}
if (process.env.lOG_INJECTION) {
  options.logInjection = process.env.lOG_INJECTION
}

// eslint-disable-next-line import/no-extraneous-dependencies
require('dd-trace').init(options)

const http = require('http')
// eslint-disable-next-line import/no-extraneous-dependencies
const pino = require('pino')
const logger = pino()

const server = http
  .createServer((req, res) => {
    logger.info('Creating server')
    res.end('hello, world\n')
  })
  .listen(0, () => {
    const port = server.address().port
    process.send({ port })
  })

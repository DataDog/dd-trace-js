'use strict'

let logger

if (process.env.TEST_LOGGER === 'bunyan') {
  logger = require('bunyan').createLogger({ name: 'test-logger' })
} else if (process.env.TEST_LOGGER === 'pino') {
  const createPino = require('pino')
  logger = createPino({ level: 'info' })
} else if (process.env.TEST_LOGGER === 'console') {
  // eslint-disable-next-line no-console
  console.warn('outside a test')
  logger = {
    // eslint-disable-next-line no-console
    error: (...args) => console.error(...args),
  }
} else {
  const { createLogger, format, transports } = require('winston')
  logger = createLogger({
    level: 'info',
    exitOnError: false,
    format: format.json(),
    transports: [
      new transports.Console(),
    ],
  })
}

module.exports = logger

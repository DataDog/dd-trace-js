'use strict'

let logger

// Requiring Pino and Bunyan twice exercises the test framework's module cache.
switch (process.env.TEST_LOGGER) {
  case 'pino':
    require('pino')
    logger = require('pino')()
    break
  case 'bunyan':
    require('bunyan')
    logger = require('bunyan').createLogger({ name: 'test-logger' })
    break
  default: {
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
}

module.exports = logger

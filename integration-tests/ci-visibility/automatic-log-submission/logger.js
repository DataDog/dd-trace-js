'use strict'

let logger

switch (process.env.TEST_LOGGER) {
  case 'pino':
    logger = require('pino')()
    break
  case 'bunyan':
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

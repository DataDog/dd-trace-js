'use strict'

const createPino = require('pino')
const { createLogger, format, transports } = require('winston')

module.exports = {
  bunyan: require('bunyan').createLogger({ name: 'test-logger' }),
  pino: createPino({ level: 'info' }),
  winston: createLogger({
    level: 'info',
    exitOnError: false,
    format: format.json(),
    transports: [
      new transports.Console(),
    ],
  }),
}

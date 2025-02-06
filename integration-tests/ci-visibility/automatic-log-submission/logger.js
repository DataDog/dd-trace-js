'use strict'

const { createLogger, format, transports } = require('winston')

module.exports = createLogger({
  level: 'info',
  exitOnError: false,
  format: format.json(),
  transports: [
    new transports.Console()
  ]
})

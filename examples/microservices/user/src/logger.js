'use strict'

const winston = require('winston')

module.exports = winston.createLogger({
  level: 'debug',
  transports: new winston.transports.Console()
})

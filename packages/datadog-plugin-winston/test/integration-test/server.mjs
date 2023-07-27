import ddtrace from 'dd-trace'
import * as pluginHelpers from './plugin-helpers.mjs'
import winston from 'winston'

ddtrace.init({
  logInjection: true
})

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'test-logger' },
  transports: [
    new winston.transports.Console()
  ]
})

pluginHelpers.onMessage(async () => {
  logger.info('test xyz')
})

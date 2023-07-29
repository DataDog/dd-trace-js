import ddtrace from 'dd-trace'
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

logger.info('test xyz')

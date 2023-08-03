import ddtrace from 'dd-trace'
import pino from 'pino'

ddtrace.init({
  logInjection: true
})

const logger = pino({ name: 'test-logger' })

logger.info('test xyz')

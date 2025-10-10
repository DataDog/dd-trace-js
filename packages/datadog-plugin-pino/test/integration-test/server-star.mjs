import ddtrace from 'dd-trace'
import * as modpino from 'pino'
const pino = modpino.default

ddtrace.init({
  logInjection: true
})

const logger = pino({ name: 'test-logger' })

logger.info('test xyz')


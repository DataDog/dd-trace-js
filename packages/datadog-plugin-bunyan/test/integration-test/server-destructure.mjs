import ddtrace from 'dd-trace'
import { default as bunyan } from 'bunyan'

ddtrace.init({
  logInjection: true
})

const logger = bunyan.createLogger({ name: 'test-logger' })

logger.info('test xyz')


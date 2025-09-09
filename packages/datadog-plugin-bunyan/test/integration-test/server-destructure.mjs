import ddtrace from 'dd-trace'
import { default as Logger } from 'bunyan'

ddtrace.init({
  logInjection: true
})

const logger = Logger.createLogger({ name: 'test-logger' })

logger.info('test xyz')

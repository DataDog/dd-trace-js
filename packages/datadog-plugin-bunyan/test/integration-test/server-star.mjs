import ddtrace from 'dd-trace'
import * as modbunyan from 'bunyan'
const bunyan = modbunyan.default

ddtrace.init({
  logInjection: true
})

const logger = bunyan.createLogger({ name: 'test-logger' })

logger.info('test xyz')


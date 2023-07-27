import ddtrace from 'dd-trace'
import * as pluginHelpers from './plugin-helpers.mjs'
import pino from 'pino'

ddtrace.init({
  logInjection: true
})

const logger = pino({ name: 'test-logger' })

pluginHelpers.onMessage(async () => {
  logger.info('test xyz')
})

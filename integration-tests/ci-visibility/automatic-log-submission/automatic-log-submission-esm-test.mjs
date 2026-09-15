import assert from 'node:assert/strict'

import { describe, it } from '@jest/globals'
import bunyan from 'bunyan'
import pino from 'pino'
import winston from 'winston'

const loggerName = process.env.TEST_LOGGER
const logger = loggerName === 'bunyan'
  ? bunyan.createLogger({ name: 'test-logger' })
  : loggerName === 'pino'
    ? pino({ level: 'info' })
    : loggerName === 'console'
      ? {
          // eslint-disable-next-line no-console
          error: (...args) => console.error(...args),
        }
      : winston.createLogger({
        level: 'info',
        exitOnError: false,
        format: winston.format.json(),
        transports: [
          new winston.transports.Console(),
        ],
      })

if (loggerName === 'console') {
  // eslint-disable-next-line no-console
  console.warn('outside a test')
}

describe('test', () => {
  it('should return true', () => {
    if (loggerName === 'winston') {
      const circular = {}
      circular.self = circular
      logger.log('info', 'Hello simple log!', { circular })
    } else if (loggerName === 'console') {
      logger.error('Hello simple log!')
    } else {
      logger.info('Hello simple log!')
    }

    if (loggerName === 'console') {
      logger.error('sum function being called')
    } else {
      logger.info('sum function being called')
    }
    assert.strictEqual(true, true)
  })
})

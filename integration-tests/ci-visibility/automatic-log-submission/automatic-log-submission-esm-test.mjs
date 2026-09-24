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
    : winston.createLogger({
      level: 'info',
      exitOnError: false,
      format: winston.format.json(),
      transports: [
        new winston.transports.Console(),
      ],
    })

describe('test', () => {
  it('should return true', () => {
    if (loggerName === 'winston') {
      const circular = {}
      circular.self = circular
      logger.log('info', 'Hello simple log!', { circular })
    } else {
      logger.info('Hello simple log!')
    }

    logger.info('sum function being called')
    assert.strictEqual(true, true)
  })
})

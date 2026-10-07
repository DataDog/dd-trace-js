import assert from 'node:assert/strict'

import { describe, it } from '@jest/globals'
import winston from 'winston'

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
})

describe('linked Winston ESM import', () => {
  it('submits logs', () => {
    logger.info('linked logger')
    assert.strictEqual(true, true)
  })
})

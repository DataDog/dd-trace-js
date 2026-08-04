'use strict'

const assert = require('assert')

const logger = require('./logger')
const sum = require('./sum')
describe('test', () => {
  it('should return true', () => {
    if (process.env.TEST_CALLER_DD) {
      logger.info({ dd: { custom: 'value' } }, 'caller-provided dd')
      return
    }

    logger.info('Hello simple log!')

    assert.strictEqual(true, true)
    if (!process.env.TEST_SINGLE_LOG) {
      assert.strictEqual(sum(1, 2), 3)
    }
  })
})

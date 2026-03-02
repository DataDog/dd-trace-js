'use strict'

const assert = require('assert')

const logger = require('./logger')
const sum = require('./sum')
describe('test', () => {
  it('should return true', () => {
    logger.log('info', 'Hello simple log!')

    assert.strictEqual(true, true)
    assert.strictEqual(sum(1, 2), 3)
  })
})

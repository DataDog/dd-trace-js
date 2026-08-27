'use strict'

const assert = require('node:assert/strict')

const logger = require('bunyan').createLogger({ name: 'test-logger' })

describe('WebdriverIO automatic log submission', () => {
  it('logs from an active Test Optimization span', () => {
    const activeSpan = require('dd-trace').scope().active()

    assert.ok(activeSpan)
    logger.info('Hello from WebdriverIO!')
  })
})

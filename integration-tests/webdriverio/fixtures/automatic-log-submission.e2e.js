'use strict'

const assert = require('node:assert/strict')

const logger = require('./automatic-log-submission-logger')

describe('WebdriverIO automatic log submission', () => {
  it('logs from an active Test Optimization span', () => {
    const activeSpan = require('dd-trace').scope().active()

    assert.ok(activeSpan)
    logger.info('Hello from WebdriverIO!')
  })
})

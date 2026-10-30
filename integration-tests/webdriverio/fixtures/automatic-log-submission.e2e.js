'use strict'

const assert = require('node:assert/strict')

const loggers = require('./automatic-log-submission-logger')

describe('WebdriverIO automatic log submission', () => {
  it('logs from an active Test Optimization span', () => {
    const activeSpan = require('dd-trace').scope().active()

    assert.ok(activeSpan)
    for (const [loggerName, logger] of Object.entries(loggers)) {
      logger.info(`Hello from WebdriverIO ${loggerName}!`)
    }
  })
})

'use strict'

const tracer = require('dd-trace')

describe('mocha-reporter-reusable-run', () => {
  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA REUSABLE FIRST HOOK EXECUTED')
  })

  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA REUSABLE SECOND HOOK EXECUTED')
  })

  it('runs again after reporter recovery', () => {
    if (process.env.MOCHA_REUSABLE_LOG_ACTIVE_TEST) {
      // eslint-disable-next-line no-console
      console.log(`MOCHA REUSABLE ACTIVE TEST: ${tracer.scope().active().context().toSpanId()}`)
    }
    // eslint-disable-next-line no-console
    console.log('MOCHA REUSABLE TEST EXECUTED')
  })
})

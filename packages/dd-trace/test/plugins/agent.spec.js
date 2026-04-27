'use strict'

const assert = require('node:assert/strict')
const { describe, it, after } = require('mocha')

const agent = require('./agent')

describe('agent.load()', () => {
  after(() => agent.close({ ritmReset: false }))

  it('completes on first call without exceeding the default mocha timeout', async () => {
    const start = Date.now()
    await agent.load('http')
    const elapsed = Date.now() - start
    // checkAgentStatus uses a 500ms socket timeout; 2500ms is 50% of the default mocha
    // timeout and well above the ~800ms expected runtime, catching regressions where
    // proxyquire.noPreserveCache() on a cold cache was taking 5–8 s.
    assert.ok(elapsed < 2500, `agent.load() took ${elapsed}ms (threshold: 2500ms)`)
  })
})

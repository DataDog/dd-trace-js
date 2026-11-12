'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

describe('WebdriverIO runner environment', () => {
  it('preserves the launcher and worker NODE_OPTIONS', () => {
    assert.strictEqual(globalThis.webdriverioRunnerEnvPreloaded, true)

    const activeSpan = tracer.scope().active()

    assert.ok(activeSpan)
    activeSpan.setTag('test.webdriverio.worker', 'runner-env-node-options')
  })
})

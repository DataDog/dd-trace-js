'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('../setup/core')

const sender = require('../../src/log-capture/sender')
const { initializeLogCapture } = require('../../src/log-capture')

const baseConfig = {
  logCaptureHost: 'localhost',
  logCapturePort: 9999,
  logCaptureProtocol: 'http:',
  logCapturePath: '/logs',
  logCaptureFlushIntervalMs: 5000,
  logCaptureMaxBufferSize: 1000,
  logCaptureTimeoutMs: 5000,
}

describe('initializeLogCapture', () => {
  beforeEach(() => {
    sender.stop()
  })

  afterEach(() => {
    globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers?.delete(sender.flush)
    sender.stop()
  })

  it('configures the sender so subsequent records are buffered', () => {
    initializeLogCapture(baseConfig)

    sender.add('{"level":30,"msg":"test"}')
    assert.strictEqual(sender.bufferSize(), 1)
  })

  it('registers flush in beforeExitHandlers', () => {
    initializeLogCapture(baseConfig)

    assert.ok(
      globalThis[Symbol.for('dd-trace')].beforeExitHandlers.has(sender.flush),
      'flush should be registered in beforeExitHandlers'
    )
  })

  it('does not register flush twice on repeated calls', () => {
    initializeLogCapture(baseConfig)
    initializeLogCapture(baseConfig)

    const handlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    assert.ok(handlers.has(sender.flush))
    assert.strictEqual([...handlers].filter(h => h === sender.flush).length, 1)
  })
})

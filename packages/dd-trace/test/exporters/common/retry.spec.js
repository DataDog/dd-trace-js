'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const RETRY_PATH = '../../../src/exporters/common/retry'

function loadRetry () {
  delete require.cache[require.resolve(RETRY_PATH)]
  return require(RETRY_PATH)
}

describe('retry', () => {
  describe('isRetriableNetworkError', () => {
    const { isRetriableNetworkError } = require(RETRY_PATH)

    it('treats agent-not-listening codes as retriable', () => {
      for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOENT']) {
        assert.strictEqual(isRetriableNetworkError({ code }), true, `expected ${code} retriable`)
      }
    })

    it('rejects misconfiguration codes and uncoded errors', () => {
      const cases = [{ code: 'ENOTFOUND' }, { code: 'EHOSTUNREACH' }, new Error('plain'), undefined]
      for (const error of cases) {
        assert.strictEqual(isRetriableNetworkError(error), false, `expected non-retriable: ${error?.code ?? error}`)
      }
    })
  })

  describe('startup grace window', () => {
    let clock

    beforeEach(() => {
      clock = sinon.useFakeTimers()
    })

    afterEach(() => {
      clock.restore()
    })

    it('applies bounded exponential backoff with jitter for the first attempts', () => {
      const retry = loadRetry()
      sinon.stub(Math, 'random').returns(0)

      try {
        assert.deepStrictEqual(
          [retry.getRetryDelay(1), retry.getRetryDelay(2), retry.getRetryDelay(3), retry.getRetryDelay(4),
            retry.getRetryDelay(5)],
          [1000, 2000, 4000, 8000, 8000]
        )
        assert.strictEqual(retry.getMaxAttempts(), 5)
      } finally {
        Math.random.restore()
      }
    })

    it('mixes jitter into the backoff', () => {
      const retry = loadRetry()
      sinon.stub(Math, 'random').returns(0.5)

      try {
        assert.strictEqual(retry.getRetryDelay(1), 1250)
      } finally {
        Math.random.restore()
      }
    })

    it('exits the grace window once the endpoint has answered', () => {
      const retry = loadRetry()
      retry.markEndpointReached()

      assert.strictEqual(retry.getMaxAttempts(), 2)
      assertSingleJitteredRange(retry.getRetryDelay(1))
    })

    it('exits the grace window once the elapsed time passes the threshold', () => {
      const retry = loadRetry()
      clock.tick(30_001)

      assert.strictEqual(retry.getMaxAttempts(), 2)
      assertSingleJitteredRange(retry.getRetryDelay(1))
    })
  })

  describe('singleJitteredDelay', () => {
    const { singleJitteredDelay } = require(RETRY_PATH)

    it('stays inside the documented 5 to 7.5 second range', () => {
      for (let attemptIndex = 0; attemptIndex < 100; attemptIndex++) {
        assertSingleJitteredRange(singleJitteredDelay())
      }
    })
  })
})

function assertSingleJitteredRange (delayMs) {
  assert.ok(delayMs >= 5000 && delayMs < 7500, `expected delay in [5000, 7500) ms, got ${delayMs}`)
}

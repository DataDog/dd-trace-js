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
    const agent = { hostname: 'agent', port: 8126 }
    const intake = { hostname: 'intake', port: 443 }
    const uds = { socketPath: '/var/run/datadog/apm.socket' }

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
          [retry.getRetryDelay(agent, 1), retry.getRetryDelay(agent, 2), retry.getRetryDelay(agent, 3),
            retry.getRetryDelay(agent, 4), retry.getRetryDelay(agent, 5)],
          [1000, 2000, 4000, 8000, 8000]
        )
        assert.strictEqual(retry.getMaxAttempts(agent), 5)
      } finally {
        Math.random.restore()
      }
    })

    it('mixes jitter into the backoff', () => {
      const retry = loadRetry()
      sinon.stub(Math, 'random').returns(0.5)

      try {
        assert.strictEqual(retry.getRetryDelay(agent, 1), 1250)
      } finally {
        Math.random.restore()
      }
    })

    it('exits the grace window for the marked endpoint only', () => {
      const retry = loadRetry()
      retry.markEndpointReached(agent)

      assert.strictEqual(retry.getMaxAttempts(agent), 2)
      assertSingleJitteredRange(retry.getRetryDelay(agent, 1))

      assert.strictEqual(retry.getMaxAttempts(intake), 5)
    })

    it('scopes the gate by socketPath without collapsing TCP endpoints', () => {
      const retry = loadRetry()
      retry.markEndpointReached(uds)

      assert.strictEqual(retry.getMaxAttempts(uds), 2)
      assert.strictEqual(retry.getMaxAttempts(agent), 5)
    })

    it('falls back to options.host when options.hostname is absent', () => {
      const retry = loadRetry()
      const hostOnly = { host: 'agent', port: 8126 }
      retry.markEndpointReached(hostOnly)

      assert.strictEqual(retry.getMaxAttempts(hostOnly), 2)
      assert.strictEqual(retry.getMaxAttempts(agent), 2)
    })

    it('groups bare options without hostname/host/port under a single key', () => {
      const retry = loadRetry()
      retry.markEndpointReached({})

      assert.strictEqual(retry.getMaxAttempts({}), 2)
      assert.strictEqual(retry.getMaxAttempts(agent), 5)
    })

    it('keeps the grace window open at the last accepted millisecond', () => {
      const retry = loadRetry()
      clock.tick(29_999)

      assert.strictEqual(retry.getMaxAttempts(agent), 5)
    })

    it('exits the grace window for every endpoint once the elapsed time passes the threshold', () => {
      const retry = loadRetry()
      clock.tick(30_000)

      assert.strictEqual(retry.getMaxAttempts(agent), 2)
      assert.strictEqual(retry.getMaxAttempts(intake), 2)
      assertSingleJitteredRange(retry.getRetryDelay(agent, 1))
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

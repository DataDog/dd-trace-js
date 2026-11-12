'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const { getRateLimitResetDelay } = require('../../../src/ci-visibility/requests/rate-limit')

describe('Test Optimization rate-limit parsing', () => {
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1_700_000_000_000 })
  })

  afterEach(() => {
    clock.restore()
  })

  it('uses the rate-limit reset duration in seconds', () => {
    assert.strictEqual(getRateLimitResetDelay({ 'x-ratelimit-reset': '5' }), 5000)
  })

  it('supports legacy absolute rate-limit reset timestamps', () => {
    const resetTimestamp = Date.now() / 1000 + 5

    assert.strictEqual(getRateLimitResetDelay({ 'x-ratelimit-reset': `${resetTimestamp}` }), 5000)
    clock.tick(4999)
    assert.strictEqual(getRateLimitResetDelay({ 'x-ratelimit-reset': `${resetTimestamp}` }), 1)
    clock.tick(1)
    assert.strictEqual(getRateLimitResetDelay({ 'x-ratelimit-reset': `${resetTimestamp}` }), 0)
  })

  it('prefers Retry-After delay seconds', () => {
    assert.strictEqual(getRateLimitResetDelay({
      'retry-after': '3',
      'x-ratelimit-reset': '5',
    }), 3000)
  })

  it('supports Retry-After HTTP dates', () => {
    const resetDate = new Date(Date.now() + 5000).toUTCString()

    assert.strictEqual(getRateLimitResetDelay({ 'retry-after': resetDate }), 5000)
  })

  it('falls back to X-RateLimit-Reset when Retry-After is negative', () => {
    assert.strictEqual(getRateLimitResetDelay({
      'retry-after': '-1',
      'x-ratelimit-reset': '5',
    }), 5000)
  })

  it('rejects missing, invalid, and negative reset delays', () => {
    assert.strictEqual(Number.isNaN(getRateLimitResetDelay()), true)
    assert.strictEqual(Number.isNaN(getRateLimitResetDelay({ 'x-ratelimit-reset': 'invalid' })), true)
    assert.strictEqual(Number.isNaN(getRateLimitResetDelay({ 'x-ratelimit-reset': '-1' })), true)
  })
})

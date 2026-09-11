'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

const { realtimeEnabled } = require('../../src/openai-realtime')

describe('openai realtime kill switch', () => {
  afterEach(() => {
    delete process.env.DD_OPENAI_REALTIME_ENABLED
  })

  it('is on by default', () => {
    assert.strictEqual(realtimeEnabled(), true)
  })

  it('is off when explicitly disabled', () => {
    // Realtime is a large wrapping surface that buffers audio in memory, so it can be turned off on
    // its own without giving up the rest of the OpenAI integration.
    for (const value of ['false', 'FALSE', '0']) {
      process.env.DD_OPENAI_REALTIME_ENABLED = value
      assert.strictEqual(realtimeEnabled(), false, value)
    }
  })

  it('stays on for any other value', () => {
    for (const value of ['true', '1', '', 'yes']) {
      process.env.DD_OPENAI_REALTIME_ENABLED = value
      assert.strictEqual(realtimeEnabled(), true, value)
    }
  })
})

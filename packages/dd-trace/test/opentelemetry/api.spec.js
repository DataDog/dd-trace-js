'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

require('../setup/core')

/**
 * Loads a fresh copy of the holder so each test starts with an empty capture map.
 *
 * @returns {typeof import('../../src/opentelemetry/api')}
 */
function freshHolder () {
  return proxyquire('../../src/opentelemetry/api', {})
}

describe('opentelemetry/api holder', () => {
  let holder

  beforeEach(() => {
    holder = freshHolder()
  })

  it('falls back to the bundled copy when nothing has been captured', () => {
    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
    assert.strictEqual(holder.getApiLogs(), require('@opentelemetry/api-logs'))
  })

  it('returns the captured copy over the bundled fallback', () => {
    const api = { trace: {}, context: {} }
    holder.setApi(holder.API, api)
    assert.strictEqual(holder.getApi(), api)
    assert.notStrictEqual(holder.getApi(), require('@opentelemetry/api'))
  })

  it('keeps the two packages independent', () => {
    const apiLogs = { logs: {} }
    holder.setApi(holder.API_LOGS, apiLogs)
    assert.strictEqual(holder.getApiLogs(), apiLogs)
    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
  })

  it('ignores a second capture so the first application copy wins', () => {
    const first = { copy: 'first' }
    const second = { copy: 'second' }
    holder.setApi(holder.API, first)
    holder.setApi(holder.API, second)
    assert.strictEqual(holder.getApi(), first)
  })
})

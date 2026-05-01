'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { normalizeService } = require('../../src/config/normalize-service')

describe('normalizeService', () => {
  it('returns undefined for falsy input', () => {
    assert.strictEqual(normalizeService(''), undefined)
    assert.strictEqual(normalizeService(undefined), undefined)
    assert.strictEqual(normalizeService(null), undefined)
  })

  it('passes already-valid service names through unchanged', () => {
    assert.strictEqual(normalizeService('my-service'), 'my-service')
    assert.strictEqual(normalizeService('payments_api'), 'payments_api')
    assert.strictEqual(normalizeService('a_b:c.d/e-f'), 'a_b:c.d/e-f')
  })

  it('lowercases uppercase input', () => {
    assert.strictEqual(normalizeService('MyService'), 'myservice')
    assert.strictEqual(normalizeService('PAYMENTS-API'), 'payments-api')
  })

  it('strips leading @ from npm scope notation', () => {
    assert.strictEqual(normalizeService('@scope/name'), 'scope/name')
    assert.strictEqual(normalizeService('@datadog/agent'), 'datadog/agent')
  })

  it('replaces disallowed characters with underscore', () => {
    assert.strictEqual(normalizeService('hello world'), 'hello_world')
    assert.strictEqual(normalizeService('foo!bar?'), 'foo_bar_')
  })

  it('strips leading non-alphanumeric runs', () => {
    assert.strictEqual(normalizeService('___leading'), 'leading')
    assert.strictEqual(normalizeService('---name'), 'name')
    assert.strictEqual(normalizeService('@@@nested'), 'nested')
  })

  it('truncates to 100 characters', () => {
    const longName = 'a'.repeat(150)
    assert.strictEqual(normalizeService(longName).length, 100)
  })

  it('returns undefined when normalization produces an empty string', () => {
    assert.strictEqual(normalizeService('@@@@'), undefined)
    assert.strictEqual(normalizeService('---'), undefined)
  })
})

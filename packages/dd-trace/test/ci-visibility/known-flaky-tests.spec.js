'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { isKnownFlakyTest } = require('../../src/ci-visibility/known-flaky-tests')

describe('known flaky test eligibility', () => {
  it('falls back to regular retries when the list is unavailable', () => {
    assert.strictEqual(isKnownFlakyTest(undefined, 'jest', 'suite.js', 'test'), true)
  })

  it('excludes every test when the backend returns an empty list', () => {
    assert.strictEqual(isKnownFlakyTest({}, 'jest', 'suite.js', 'test'), false)
  })

  it('matches the complete module, suite and test identity', () => {
    const tests = { jest: { 'suite.js': ['test'] } }
    assert.strictEqual(isKnownFlakyTest(tests, 'jest', 'suite.js', 'test'), true)
    assert.strictEqual(isKnownFlakyTest(tests, 'mocha', 'suite.js', 'test'), false)
    assert.strictEqual(isKnownFlakyTest(tests, 'jest', 'other.js', 'test'), false)
    assert.strictEqual(isKnownFlakyTest(tests, 'jest', 'suite.js', 'other'), false)
    assert.strictEqual(isKnownFlakyTest(tests, 'constructor', 'prototype', 'test'), false)
  })

  it('keeps serialized and frozen suite lists unchanged across repeated lookups', () => {
    const tests = { mocha: { 'suite.js': Object.freeze(['first', 'last']) } }
    const serialized = JSON.stringify(tests)
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.strictEqual(isKnownFlakyTest(tests, 'mocha', 'suite.js', 'last'), true)
      assert.strictEqual(isKnownFlakyTest(tests, 'mocha', 'suite.js', 'missing'), false)
    }
    assert.strictEqual(JSON.stringify(tests), serialized)
  })

  it('uses replacement and deserialized lists without retaining old names', () => {
    const tests = { mocha: { 'suite.js': ['old'] } }
    assert.strictEqual(isKnownFlakyTest(tests, 'mocha', 'suite.js', 'old'), true)
    tests.mocha['suite.js'] = ['new']
    for (const configuration of [tests, JSON.parse(JSON.stringify(tests))]) {
      assert.strictEqual(isKnownFlakyTest(configuration, 'mocha', 'suite.js', 'old'), false)
      assert.strictEqual(isKnownFlakyTest(configuration, 'mocha', 'suite.js', 'new'), true)
    }
  })
})

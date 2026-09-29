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
})

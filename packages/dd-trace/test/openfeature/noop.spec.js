'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const NoopFlaggingProvider = require('../../src/openfeature/noop')

describe('NoopFlaggingProvider', () => {
  let noopProvider

  beforeEach(() => {
    noopProvider = new NoopFlaggingProvider()
  })

  describe('constructor', () => {
    it('should initialize with OpenFeature Provider properties', () => {
      assert.deepStrictEqual(noopProvider.metadata, { name: 'NoopFlaggingProvider' })
      assert.strictEqual(noopProvider.status, 'NOT_READY')
      assert.strictEqual(noopProvider.runsOn, 'server')
    })
  })

  describe('OpenFeature Provider interface methods', () => {
    it('should resolve boolean evaluation with default value', async () => {
      const result = await noopProvider.resolveBooleanEvaluation('test-flag', true, {}, {})
      assert.deepStrictEqual(result, {
        value: true,
        reason: 'STATIC',
      })

      const result2 = await noopProvider.resolveBooleanEvaluation('test-flag', false, {}, {})
      assert.deepStrictEqual(result2, {
        value: false,
        reason: 'STATIC',
      })
    })

    it('should resolve string evaluation with default value', async () => {
      const result = await noopProvider.resolveStringEvaluation('test-flag', 'default', {}, {})
      assert.deepStrictEqual(result, {
        value: 'default',
        reason: 'STATIC',
      })

      const result2 = await noopProvider.resolveStringEvaluation('test-flag', 'custom', {}, {})
      assert.deepStrictEqual(result2, {
        value: 'custom',
        reason: 'STATIC',
      })
    })

    it('should resolve number evaluation with default value', async () => {
      const result = await noopProvider.resolveNumberEvaluation('test-flag', 42, {}, {})
      assert.deepStrictEqual(result, {
        value: 42,
        reason: 'STATIC',
      })

      const result2 = await noopProvider.resolveNumberEvaluation('test-flag', 0, {}, {})
      assert.deepStrictEqual(result2, {
        value: 0,
        reason: 'STATIC',
      })
    })

    it('should resolve object evaluation with default value', async () => {
      const defaultObj = { test: 'value' }
      const result = await noopProvider.resolveObjectEvaluation('test-flag', defaultObj, {}, {})
      assert.deepStrictEqual(result, {
        value: defaultObj,
        reason: 'STATIC',
      })

      const emptyObj = {}
      const result2 = await noopProvider.resolveObjectEvaluation('test-flag', emptyObj, {}, {})
      assert.deepStrictEqual(result2, {
        value: emptyObj,
        reason: 'STATIC',
      })
    })

    it('should handle missing parameters', async () => {
      const result = await noopProvider.resolveBooleanEvaluation('test-flag', true)
      assert.deepStrictEqual(result, {
        value: true,
        reason: 'STATIC',
      })
    })
  })

  describe('promise handling', () => {
    it('should return promises from all evaluation methods', () => {
      const booleanResult = noopProvider.resolveBooleanEvaluation('test', true, {}, {})
      const stringResult = noopProvider.resolveStringEvaluation('test', 'default', {}, {})
      const numberResult = noopProvider.resolveNumberEvaluation('test', 42, {}, {})
      const objectResult = noopProvider.resolveObjectEvaluation('test', {}, {}, {})

      assert.ok(
        booleanResult && typeof booleanResult.then === 'function',
        `Expected a thenable, got: ${inspect(booleanResult)}`
      )
      assert.ok(
        stringResult && typeof stringResult.then === 'function',
        `Expected a thenable, got: ${inspect(stringResult)}`
      )
      assert.ok(
        numberResult && typeof numberResult.then === 'function',
        `Expected a thenable, got: ${inspect(numberResult)}`
      )
      assert.ok(
        objectResult && typeof objectResult.then === 'function',
        `Expected a thenable, got: ${inspect(objectResult)}`
      )
    })
  })
})

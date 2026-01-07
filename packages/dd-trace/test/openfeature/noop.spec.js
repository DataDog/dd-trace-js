'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const NoopFlaggingProvider = require('../../src/openfeature/noop')

describe('NoopFlaggingProvider', () => {
  let noopProvider
  let mockTracer

  beforeEach(() => {
    mockTracer = {}
    noopProvider = new NoopFlaggingProvider(mockTracer)
  })

  describe('constructor', () => {
    it('should store tracer reference', () => {
      assert.strictEqual(noopProvider._tracer, mockTracer)
    })

    it('should initialize with OpenFeature Provider properties', () => {
      assert.deepStrictEqual(noopProvider.metadata, { name: 'NoopFlaggingProvider' })
      assert.strictEqual(noopProvider.status, 'NOT_READY')
      assert.strictEqual(noopProvider.runsOn, 'server')
      assert.deepStrictEqual(noopProvider._config, {})
    })
  })

  describe('OpenFeature Provider interface methods', () => {
    it('should resolve boolean evaluation with default value', async () => {
      const result = await noopProvider.resolveBooleanEvaluation('test-flag', true, {}, {})
      assert.deepStrictEqual(result, {
        value: true,
        reason: 'STATIC'
      })

      const result2 = await noopProvider.resolveBooleanEvaluation('test-flag', false, {}, {})
      assert.deepStrictEqual(result2, {
        value: false,
        reason: 'STATIC'
      })
    })

    it('should resolve string evaluation with default value', async () => {
      const result = await noopProvider.resolveStringEvaluation('test-flag', 'default', {}, {})
      assert.deepStrictEqual(result, {
        value: 'default',
        reason: 'STATIC'
      })

      const result2 = await noopProvider.resolveStringEvaluation('test-flag', 'custom', {}, {})
      assert.deepStrictEqual(result2, {
        value: 'custom',
        reason: 'STATIC'
      })
    })

    it('should resolve number evaluation with default value', async () => {
      const result = await noopProvider.resolveNumberEvaluation('test-flag', 42, {}, {})
      assert.deepStrictEqual(result, {
        value: 42,
        reason: 'STATIC'
      })

      const result2 = await noopProvider.resolveNumberEvaluation('test-flag', 0, {}, {})
      assert.deepStrictEqual(result2, {
        value: 0,
        reason: 'STATIC'
      })
    })

    it('should resolve object evaluation with default value', async () => {
      const defaultObj = { test: 'value' }
      const result = await noopProvider.resolveObjectEvaluation('test-flag', defaultObj, {}, {})
      assert.deepStrictEqual(result, {
        value: defaultObj,
        reason: 'STATIC'
      })

      const emptyObj = {}
      const result2 = await noopProvider.resolveObjectEvaluation('test-flag', emptyObj, {}, {})
      assert.deepStrictEqual(result2, {
        value: emptyObj,
        reason: 'STATIC'
      })
    })

    it('should handle missing parameters', async () => {
      const result = await noopProvider.resolveBooleanEvaluation('test-flag', true)
      assert.deepStrictEqual(result, {
        value: true,
        reason: 'STATIC'
      })
    })
  })

  describe('configuration methods', () => {
    it('should handle setConfiguration', () => {
      const config = { flags: { 'test-flag': {} } }
      assert.doesNotThrow(() => noopProvider.setConfiguration(config))

      const result = noopProvider.getConfiguration()
      assert.deepStrictEqual(result, config)
    })

    it('should handle _setConfiguration wrapper', () => {
      const config = { flags: { 'test-flag': {} } }
      assert.doesNotThrow(() => noopProvider._setConfiguration(config))

      const result = noopProvider.getConfiguration()
      assert.deepStrictEqual(result, config)
    })

    it('should handle empty or null configuration', () => {
      assert.doesNotThrow(() => noopProvider.setConfiguration(null))
      assert.doesNotThrow(() => noopProvider.setConfiguration(undefined))
      assert.doesNotThrow(() => noopProvider._setConfiguration())
      assert.doesNotThrow(() => noopProvider._setConfiguration(null))
    })

    it('should return stored configuration', () => {
      const config = { flags: {} }
      noopProvider.setConfiguration(config)
      const result = noopProvider.getConfiguration()
      assert.strictEqual(result, config)
    })
  })

  describe('promise handling', () => {
    it('should return promises from all evaluation methods', () => {
      const booleanResult = noopProvider.resolveBooleanEvaluation('test', true, {}, {})
      const stringResult = noopProvider.resolveStringEvaluation('test', 'default', {}, {})
      const numberResult = noopProvider.resolveNumberEvaluation('test', 42, {}, {})
      const objectResult = noopProvider.resolveObjectEvaluation('test', {}, {}, {})

      assert.ok(booleanResult && typeof booleanResult.then === 'function')
      assert.ok(stringResult && typeof stringResult.then === 'function')
      assert.ok(numberResult && typeof numberResult.then === 'function')
      assert.ok(objectResult && typeof objectResult.then === 'function')
    })

    it('should resolve promises immediately', async () => {
      const start = Date.now()

      await Promise.all([
        noopProvider.resolveBooleanEvaluation('test', true, {}, {}),
        noopProvider.resolveStringEvaluation('test', 'default', {}, {}),
        noopProvider.resolveNumberEvaluation('test', 42, {}, {}),
        noopProvider.resolveObjectEvaluation('test', {}, {}, {})
      ])

      const duration = Date.now() - start
      assert.ok(duration < 10)
    })
  })
})

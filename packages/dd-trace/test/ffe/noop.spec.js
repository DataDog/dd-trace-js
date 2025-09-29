'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha

require('../setup/core')

const NoopFlaggingProvider = require('../../src/ffe/noop')

describe('NoopFlaggingProvider', () => {
  let noopProvider
  let mockTracer

  beforeEach(() => {
    mockTracer = {}
    noopProvider = new NoopFlaggingProvider(mockTracer)
  })

  describe('constructor', () => {
    it('should store tracer reference', () => {
      expect(noopProvider._tracer).to.equal(mockTracer)
    })

    it('should initialize with OpenFeature Provider properties', () => {
      expect(noopProvider.metadata).to.deep.equal({ name: 'NoopFlaggingProvider' })
      expect(noopProvider.status).to.equal('NOT_READY')
      expect(noopProvider.runsOn).to.equal('server')
      expect(noopProvider._config).to.deep.equal({})
    })
  })

  describe('OpenFeature Provider interface methods', () => {
    it('should resolve boolean evaluation with default value', async () => {
      const result = await noopProvider.resolveBooleanEvaluation('test-flag', true, {}, {})
      expect(result).to.deep.equal({
        value: true,
        reason: 'DEFAULT'
      })

      const result2 = await noopProvider.resolveBooleanEvaluation('test-flag', false, {}, {})
      expect(result2).to.deep.equal({
        value: false,
        reason: 'DEFAULT'
      })
    })

    it('should resolve string evaluation with default value', async () => {
      const result = await noopProvider.resolveStringEvaluation('test-flag', 'default', {}, {})
      expect(result).to.deep.equal({
        value: 'default',
        reason: 'DEFAULT'
      })

      const result2 = await noopProvider.resolveStringEvaluation('test-flag', 'custom', {}, {})
      expect(result2).to.deep.equal({
        value: 'custom',
        reason: 'DEFAULT'
      })
    })

    it('should resolve number evaluation with default value', async () => {
      const result = await noopProvider.resolveNumberEvaluation('test-flag', 42, {}, {})
      expect(result).to.deep.equal({
        value: 42,
        reason: 'DEFAULT'
      })

      const result2 = await noopProvider.resolveNumberEvaluation('test-flag', 0, {}, {})
      expect(result2).to.deep.equal({
        value: 0,
        reason: 'DEFAULT'
      })
    })

    it('should resolve object evaluation with default value', async () => {
      const defaultObj = { test: 'value' }
      const result = await noopProvider.resolveObjectEvaluation('test-flag', defaultObj, {}, {})
      expect(result).to.deep.equal({
        value: defaultObj,
        reason: 'DEFAULT'
      })

      const emptyObj = {}
      const result2 = await noopProvider.resolveObjectEvaluation('test-flag', emptyObj, {}, {})
      expect(result2).to.deep.equal({
        value: emptyObj,
        reason: 'DEFAULT'
      })
    })

    it('should handle missing parameters', async () => {
      const result = await noopProvider.resolveBooleanEvaluation('test-flag', true)
      expect(result).to.deep.equal({
        value: true,
        reason: 'DEFAULT'
      })
    })
  })

  describe('configuration methods', () => {
    it('should handle setConfiguration', () => {
      const config = { flags: { 'test-flag': {} } }
      expect(() => noopProvider.setConfiguration(config)).to.not.throw()

      const result = noopProvider.getConfiguration()
      expect(result).to.deep.equal(config)
    })

    it('should handle _setConfiguration wrapper', () => {
      const config = { flags: { 'test-flag': {} } }
      expect(() => noopProvider._setConfiguration(config)).to.not.throw()

      const result = noopProvider.getConfiguration()
      expect(result).to.deep.equal(config)
    })

    it('should handle empty or null configuration', () => {
      expect(() => noopProvider.setConfiguration(null)).to.not.throw()
      expect(() => noopProvider.setConfiguration(undefined)).to.not.throw()
      expect(() => noopProvider._setConfiguration()).to.not.throw()
      expect(() => noopProvider._setConfiguration(null)).to.not.throw()
    })

    it('should return stored configuration', () => {
      const config = { flags: {} }
      noopProvider.setConfiguration(config)
      const result = noopProvider.getConfiguration()
      expect(result).to.equal(config)
    })
  })

  describe('promise handling', () => {
    it('should return promises from all evaluation methods', () => {
      const booleanResult = noopProvider.resolveBooleanEvaluation('test', true, {}, {})
      const stringResult = noopProvider.resolveStringEvaluation('test', 'default', {}, {})
      const numberResult = noopProvider.resolveNumberEvaluation('test', 42, {}, {})
      const objectResult = noopProvider.resolveObjectEvaluation('test', {}, {}, {})

      expect(booleanResult).to.be.a('promise')
      expect(stringResult).to.be.a('promise')
      expect(numberResult).to.be.a('promise')
      expect(objectResult).to.be.a('promise')
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
      expect(duration).to.be.lessThan(10) // Should resolve immediately
    })
  })
})

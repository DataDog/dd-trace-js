'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const iastContextHandler = require('../../../src/appsec/iast/iast-context')
describe('IAST context', () => {
  const iastContext = 'IAST_CONTEXT'

  describe('getIastContext', () => {
    it('should obtain iast context from provided store', () => {
      const store = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      const returnedIastContext = iastContextHandler.getIastContext(store)
      assert.notStrictEqual(returnedIastContext, null)
      assert.strictEqual(returnedIastContext, iastContext)
    })

    it('should return undefined when no store is provided', () => {
      assert.strictEqual(iastContextHandler.getIastContext(), undefined)
    })

    it('should obtain iast context from topContext if store does not provide one', () => {
      const store = {}
      const topContext = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      assert.strictEqual(iastContextHandler.getIastContext(store, topContext), iastContext)
    })

    it('should not fail if no topContext is provided', () => {
      const store = {}
      const topContext = undefined
      assert.strictEqual(iastContextHandler.getIastContext(store, topContext), undefined)
    })
  })

  describe('saveIastContext', () => {
    it('should populate and return iast context on store and topContext', () => {
      const store = {}
      const topContext = {}
      const returnedIastContext = iastContextHandler.saveIastContext(store, topContext, iastContext)
      assert.notStrictEqual(returnedIastContext, null)
      assert.strictEqual(returnedIastContext, iastContext)
      assert.notStrictEqual(store[iastContextHandler.IAST_CONTEXT_KEY], null)
      assert.strictEqual(store[iastContextHandler.IAST_CONTEXT_KEY], iastContext)
      assert.notStrictEqual(topContext[iastContextHandler.IAST_CONTEXT_KEY], null)
      assert.strictEqual(topContext[iastContextHandler.IAST_CONTEXT_KEY], iastContext)
    })

    it('should not populate and return undefined if no store is provided', () => {
      const store = undefined
      const topContext = {}
      const returnedIastContext = iastContextHandler.saveIastContext(store, topContext, iastContext)
      assert.strictEqual(returnedIastContext, undefined)
      assert.strictEqual(topContext[iastContextHandler.IAST_CONTEXT_KEY], undefined)
    })

    it('should not populate and return undefined if no topContext is provided', () => {
      const store = {}
      const topContext = undefined
      const returnedIastContext = iastContextHandler.saveIastContext(store, topContext, iastContext)
      assert.strictEqual(returnedIastContext, undefined)
      assert.strictEqual(store[iastContextHandler.IAST_CONTEXT_KEY], undefined)
    })

    it('should not populate and return undefined if no store nor topContext are provided', () => {
      const store = undefined
      const topContext = undefined
      const returnedIastContext = iastContextHandler.saveIastContext(store, topContext, iastContext)
      assert.strictEqual(returnedIastContext, undefined)
    })
  })

  describe('cleanIastContext', () => {
    it('should null iast context in both store and top context', () => {
      const store = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      const topContext = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      iastContextHandler.cleanIastContext(store, topContext, iastContext)
      assert.strictEqual(store[iastContextHandler.IAST_CONTEXT_KEY], null)
      assert.strictEqual(topContext[iastContextHandler.IAST_CONTEXT_KEY], null)
    })

    it('should return true if context exist in store', () => {
      const store = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      const topContext = {}
      const result = iastContextHandler.cleanIastContext(store, topContext)
      assert.strictEqual(result, true)
    })

    it('should return true if context exist in top context', () => {
      const store = {}
      const topContext = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      const result = iastContextHandler.cleanIastContext(store, topContext)
      assert.strictEqual(result, true)
    })

    it('should return false if context does not exist on store nor on top context', () => {
      const store = {}
      const topContext = {}
      const result = iastContextHandler.cleanIastContext(store, topContext)
      assert.strictEqual(result, false)
    })
  })
})

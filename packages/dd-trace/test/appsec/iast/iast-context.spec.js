'use strict'

const proxyquire = require('proxyquire')

describe('IAST context', () => {
  const iastContext = 'IAST_CONTEXT'
  let datadogCore
  let iastContextHandler
  beforeEach(() => {
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }
    iastContextHandler = proxyquire('../../../src/appsec/iast/iast-context', {
      '../../../../datadog-core': datadogCore
    })
  })

  describe('getIastContext', () => {
    it('should obtain iast context from provided store', () => {
      const store = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      const returnedIastContext = iastContextHandler.getIastContext(store)
      expect(returnedIastContext).to.be.not.null
      expect(returnedIastContext).to.be.equal(iastContext)
    })

    it('should obtain iast context from storage when store is not provided', () => {
      const store = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      datadogCore.storage.getStore.returns(store)
      const returnedIastContext = iastContextHandler.getIastContext()
      expect(returnedIastContext).to.be.not.null
      expect(returnedIastContext).to.be.equal(iastContext)
    })

    it('should return when no store is provided and no store is available in storage', () => {
      datadogCore.storage.getStore.returns()
      const returnedIastContext = iastContextHandler.getIastContext()
      expect(returnedIastContext).to.be.undefined
    })
  })

  describe('saveIastContext', () => {
    it('should populate and return iast context on store and topContext', () => {
      const store = {}
      const topContext = {}
      const returnedIastContext = iastContextHandler.saveIastContext(store, topContext, iastContext)
      expect(returnedIastContext).to.be.not.null
      expect(returnedIastContext).to.be.equal(iastContext)
      expect(store[iastContextHandler.IAST_CONTEXT_KEY]).to.be.not.null
      expect(store[iastContextHandler.IAST_CONTEXT_KEY]).to.be.equal(iastContext)
      expect(topContext[iastContextHandler.IAST_CONTEXT_KEY]).to.be.not.null
      expect(topContext[iastContextHandler.IAST_CONTEXT_KEY]).to.be.equal(iastContext)
    })

    it('should not populate and return undefined if no store is provided', () => {
      const store = undefined
      const topContext = {}
      const returnedIastContext = iastContextHandler.saveIastContext(store, topContext, iastContext)
      expect(returnedIastContext).to.be.undefined
      expect(topContext[iastContextHandler.IAST_CONTEXT_KEY]).to.be.undefined
    })

    it('should not populate and return undefined if no topContext is provided', () => {
      const store = {}
      const topContext = undefined
      const returnedIastContext = iastContextHandler.saveIastContext(store, topContext, iastContext)
      expect(returnedIastContext).to.be.undefined
      expect(store[iastContextHandler.IAST_CONTEXT_KEY]).to.be.undefined
    })

    it('should not populate and return undefined if no store nor topContext are provided', () => {
      const store = undefined
      const topContext = undefined
      const returnedIastContext = iastContextHandler.saveIastContext(store, topContext, iastContext)
      expect(returnedIastContext).to.be.undefined
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
      iastContextHandler.cleanIastContext(store, topContext)
      expect(store[iastContextHandler.IAST_CONTEXT_KEY]).to.be.null
      expect(topContext[iastContextHandler.IAST_CONTEXT_KEY]).to.be.null
    })

    it('should return true if context exist in store', () => {
      const store = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      const topContext = {}
      const result = iastContextHandler.cleanIastContext(store, topContext)
      expect(result).to.be.true
    })

    it('should return true if context exist in top context', () => {
      const store = {}
      const topContext = {
        [iastContextHandler.IAST_CONTEXT_KEY]: iastContext
      }
      const result = iastContextHandler.cleanIastContext(store, topContext)
      expect(result).to.be.true
    })

    it('should return false if context does not exist on store nor on top context', () => {
      const store = {}
      const topContext = {}
      const result = iastContextHandler.cleanIastContext(store, topContext)
      expect(result).to.be.false
    })
  })
})

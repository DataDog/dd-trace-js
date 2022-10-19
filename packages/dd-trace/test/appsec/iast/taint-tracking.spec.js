'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

describe('IAST TaintTracking', () => {
  let taintedUtils
  let tainTracking
  beforeEach(() => {
    taintedUtils = {
      createTransaction: id => id,
      removeTransaction: id => id
    }
    tainTracking = proxyquire('../../../src/appsec/iast/taint-tracking', {
      '@datadog/native-iast-taint-tracking': sinon.spy(taintedUtils)
    })
  })

  afterEach(sinon.restore)

  describe('createTransaction', () => {

    it('Given not null id and not null iastContext should call TaintedUtils.createTransaction and set IAST_TRANSACTION_ID in iastContext', () => {
      const iastContext = {}
      const transactionId = 'id'
      tainTracking.createTransaction(transactionId, iastContext)
      expect(taintedUtils.createTransaction).to.be.calledOnce
      expect(iastContext[tainTracking.IAST_TRANSACTION_ID]).to.be.equal(transactionId)
    })

    it('Given null id and not null iastContext should not call TaintedUtils.createTransaction', () => {
      const iastContext = {}
      const transactionId = null
      tainTracking.createTransaction(transactionId, iastContext)
      expect(taintedUtils.createTransaction).not.to.be.called
      expect(iastContext[tainTracking.IAST_TRANSACTION_ID]).to.be.undefined
    })

    it('Given not null id and null iastContext should not call TaintedUtils.createTransaction', () => {
      const iastContext = null
      const transactionId = 'id'
      tainTracking.createTransaction(transactionId, iastContext)
      expect(taintedUtils.createTransaction).not.to.be.called
      expect(iastContext).to.be.null
    })
  })

  describe('removeTransaction', () => {
    it('Given not null iastContext with defined IAST_TRANSACTION_ID should call TaintedUtils.removeTransaction', () => {
      const iastContext = {
        [tainTracking.IAST_TRANSACTION_ID]: 'id'
      }
      tainTracking.removeTransaction(iastContext)
      expect(taintedUtils.removeTransaction).to.be.calledWithExactly(iastContext[tainTracking.IAST_TRANSACTION_ID])
    })

    it('Given iastContext with undefined IAST_TRANSACTION_ID should not call TaintedUtils.removeTransaction', () => {
      const iastContext = {}
      tainTracking.removeTransaction(iastContext)
      expect(taintedUtils.removeTransaction).not.to.be.called
    })

    it('Given null iastContext should call not TaintedUtils.removeTransaction', () => {
      const iastContext = null
      tainTracking.removeTransaction(iastContext)
      expect(taintedUtils.removeTransaction).not.to.be.called
    })
  })

  describe('enableTaintTracking', () => {
    
  })
})
'use strict'

require('../../../../../dd-trace/test/setup/tap')

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')

describe('IAST TaintTracking Operations', () => {
  let taintTrackingOperations

  const taintedUtils = {
    createTransaction: id => id,
    removeTransaction: id => id,
    newTaintedString: (id) => id,
    isTainted: id => id,
    getRanges: id => id,
    concat: (id) => id
  }

  const store = {}

  const datadogCore = {
    storage: {
      getStore: () => store
    }
  }

  beforeEach(() => {
    taintTrackingOperations = proxyquire('../../../../src/appsec/iast/taint-tracking/operations', {
      '@datadog/native-iast-taint-tracking': sinon.spy(taintedUtils),
      '../../../../../datadog-core': datadogCore
    })
  })

  afterEach(sinon.restore)

  it('Addon should return a TaintedUtils instance', () => {
    let TaintedUtils = null
    expect(() => {
      TaintedUtils = require('@datadog/native-iast-taint-tracking')
    }).to.not.throw(Error)
    expect(TaintedUtils).to.not.be.null
  })

  describe('createTransaction', () => {
    it('Given not null id and not null iastContext should createTransaction', () => {
      const iastContext = {}
      const transactionId = 'id'
      taintTrackingOperations.createTransaction(transactionId, iastContext)
      expect(taintedUtils.createTransaction).to.be.calledOnce
      expect(iastContext[taintTrackingOperations.IAST_TRANSACTION_ID]).to.be.equal(transactionId)
    })

    it('Given null id and not null iastContext should not createTransaction', () => {
      const iastContext = {}
      const transactionId = null
      taintTrackingOperations.createTransaction(transactionId, iastContext)
      expect(taintedUtils.createTransaction).not.to.be.called
      expect(iastContext[taintTrackingOperations.IAST_TRANSACTION_ID]).to.be.undefined
    })

    it('Given not null id and null iastContext should not createTransaction', () => {
      const iastContext = null
      const transactionId = 'id'
      taintTrackingOperations.createTransaction(transactionId, iastContext)
      expect(taintedUtils.createTransaction).not.to.be.called
      expect(iastContext).to.be.null
    })
  })

  describe('removeTransaction', () => {
    it('Given not null iastContext with defined IAST_TRANSACTION_ID should removeTransaction', () => {
      const transactionId = 'TRANSACTION_ID'
      const iastContext = {
        [taintTrackingOperations.IAST_TRANSACTION_ID]: transactionId
      }
      taintTrackingOperations.removeTransaction(iastContext)
      expect(taintedUtils.removeTransaction).to.be.calledWithExactly(
        transactionId
      )
      expect(iastContext[taintTrackingOperations.IAST_TRANSACTION_ID]).to.be.undefined
    })

    it('Given iastContext with undefined IAST_TRANSACTION_ID should not removeTransaction', () => {
      const iastContext = {}
      taintTrackingOperations.removeTransaction(iastContext)
      expect(taintedUtils.removeTransaction).not.to.be.called
    })

    it('Given null iastContext should call not removeTransaction', () => {
      const iastContext = null
      taintTrackingOperations.removeTransaction(iastContext)
      expect(taintedUtils.removeTransaction).not.to.be.called
    })
  })

  describe('enableTaintTracking', () => {
    beforeEach(() => {
      iastContextFunctions.saveIastContext(
        store,
        {},
        { [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id' }
      )
    })

    it('Should set a not dummy global._ddiast object', () => {
      taintTrackingOperations.enableTaintOperations()

      // taintedUtils is declared in global scope
      expect(global._ddiast).not.to.be.undefined
      expect(global._ddiast.plusOperator).not.to.be.undefined

      // taintedUtils methods are called
      global._ddiast.plusOperator('helloworld', 'hello', 'world')
      expect(taintedUtils.concat).to.be.called
    })

    it('Should set dummy global._ddiast object', () => {
      taintTrackingOperations.disableTaintOperations()

      // dummy taintedUtils is declared in global scope
      expect(global._ddiast).not.to.be.undefined
      expect(global._ddiast.plusOperator).not.to.be.undefined

      // taintedUtils methods are not called
      global._ddiast.plusOperator('helloworld', 'hello', 'world')
      expect(taintedUtils.concat).not.to.be.called
    })
  })

  describe('newTaintedString', () => {
    it('Given not null iastContext with defined IAST_TRANSACTION_ID should call TaintedUtils.newTaintedString', () => {
      const iastContext = {
        [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id'
      }
      const value = 'value'
      const param = 'param'
      const type = 'REQUEST'
      taintTrackingOperations.newTaintedString(iastContext, value, param, type)
      expect(taintedUtils.newTaintedString).to.be.called
      expect(taintedUtils.newTaintedString).to.be
        .calledWithExactly(iastContext[taintTrackingOperations.IAST_TRANSACTION_ID], value, param, type)
    })
    it('Given iastContext with undefined IAST_TRANSACTION_ID should not call TaintedUtils.newTaintedString', () => {
      const iastContext = {}
      taintTrackingOperations.newTaintedString(iastContext)
      expect(taintedUtils.newTaintedString).not.to.be.called
    })

    it('Given null iastContext should call not TaintedUtils.newTaintedString', () => {
      const iastContext = null
      taintTrackingOperations.newTaintedString(iastContext)
      expect(taintedUtils.newTaintedString).not.to.be.called
    })

    it('Given null iastContext should return the string passed as parameter', () => {
      const iastContext = null
      const value = 'test'
      const result = taintTrackingOperations.newTaintedString(iastContext, value)
      expect(result).to.be.equal('test')
    })
  })

  describe('isTainted', () => {
    it('Given not null iastContext with defined IAST_TRANSACTION_ID should call TaintedUtils.isTainted', () => {
      const iastContext = {
        [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id'
      }
      const value = 'value'
      taintTrackingOperations.isTainted(iastContext, value)
      expect(taintedUtils.isTainted).to.be.called
      expect(taintedUtils.isTainted).to.be.calledWithExactly(
        iastContext[taintTrackingOperations.IAST_TRANSACTION_ID],
        value
      )
    })
    it('Given iastContext with undefined IAST_TRANSACTION_ID should not call TaintedUtils.isTainted', () => {
      const iastContext = {}
      taintTrackingOperations.isTainted(iastContext)
      expect(taintedUtils.isTainted).not.to.be.called
    })

    it('Given null iastContext should call not TaintedUtils.isTainted', () => {
      const iastContext = null
      taintTrackingOperations.isTainted(iastContext)
      expect(taintedUtils.isTainted).not.to.be.called
    })
  })

  describe('getRanges', () => {
    it('Given not null iastContext with defined IAST_TRANSACTION_ID should call TaintedUtils.getRanges', () => {
      const iastContext = {
        [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id'
      }
      const value = 'value'
      taintTrackingOperations.getRanges(iastContext, value)
      expect(taintedUtils.getRanges).to.be.called
      expect(taintedUtils.getRanges).to.be.calledWithExactly(
        iastContext[taintTrackingOperations.IAST_TRANSACTION_ID],
        value
      )
    })

    it('Given iastContext with undefined IAST_TRANSACTION_ID should not call TaintedUtils.getRanges', () => {
      const iastContext = {}
      taintTrackingOperations.getRanges(iastContext)
      expect(taintedUtils.getRanges).not.to.be.called
    })

    it('Given null iastContext should call not TaintedUtils.getRanges', () => {
      const iastContext = null
      taintTrackingOperations.getRanges(iastContext)
      expect(taintedUtils.getRanges).not.to.be.called
    })

    it('Given null iastContext should return empty array', () => {
      const result = taintTrackingOperations.getRanges(null)
      expect(result).to.be.instanceof(Array)
      expect(result).to.have.length(0)
    })
  })

  describe('plusOperator', () => {
    beforeEach(() => {
      iastContextFunctions.saveIastContext(store, {}, { [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id' })
      taintTrackingOperations.enableTaintOperations()
    })

    it('Should not call taintedUtils.concat method if result is not a string', () => {
      global._ddiast.plusOperator(1 + 2, 1, 2)
      expect(taintedUtils.concat).not.to.be.called
    })

    it('Should not call taintedUtils.concat method if both operands are not string', () => {
      const a = { x: 'hello' }
      const b = { y: 'world' }
      global._ddiast.plusOperator(a + b, a, b)
      expect(taintedUtils.concat).not.to.be.called
    })

    it('Should not call taintedUtils.concat method if there is not an active transaction', () => {
      iastContextFunctions.saveIastContext(store, {}, { [taintTrackingOperations.IAST_TRANSACTION_ID]: null })
      global._ddiast.plusOperator('helloworld', 'hello', 'world')
      expect(taintedUtils.concat).not.to.be.called
    })

    it('Should not fail if taintTracking is not enabled', () => {
      taintTrackingOperations.disableTaintOperations()
      const res = global._ddiast.plusOperator('helloworld', 'hello', 'world')
      expect(taintedUtils.concat).not.to.be.called
      expect(res).equal('helloworld')
    })
  })
})

'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { csiMethods } = require('../../../../src/appsec/iast/taint-tracking/csi-methods')
const iastTelemetry = require('../../../../src/appsec/iast/telemetry')
const { EXECUTED_PROPAGATION, REQUEST_TAINTED } = require('../../../../src/appsec/iast/telemetry/iast-metric')
const { Verbosity } = require('../../../../src/appsec/iast/telemetry/verbosity')

function getExpectedMethods () {
  const set = new Set()
  for (const definition of csiMethods) {
    if (definition.dst) {
      set.add(definition.dst)
    } else {
      set.add(definition.src)
    }
  }
  return [...set]
}

describe('IAST TaintTracking Operations', () => {
  let taintTrackingOperations
  let taintTrackingImpl
  let taintedUtilsMock
  const taintedUtils = {
    createTransaction: id => id,
    removeTransaction: id => id,
    setMaxTransactions: () => {},
    newTaintedString: (id, value) => value,
    isTainted: id => id,
    getRanges: id => id,
    concat: id => id,
    trim: id => id,
    getMetrics: id => {
      return {
        requestCount: 5
      }
    }
  }

  const store = {}

  const datadogCore = {
    storage: {
      getStore: () => store
    }
  }

  beforeEach(() => {
    taintedUtilsMock = sinon.spy(taintedUtils)
    taintTrackingImpl = proxyquire('../../../../src/appsec/iast/taint-tracking/taint-tracking-impl', {
      '@datadog/native-iast-taint-tracking': taintedUtilsMock,
      '../../../../../datadog-core': datadogCore
    })
    taintTrackingOperations = proxyquire('../../../../src/appsec/iast/taint-tracking/operations', {
      '@datadog/native-iast-taint-tracking': taintedUtilsMock,
      '../../../../../datadog-core': datadogCore,
      './taint-tracking-impl': taintTrackingImpl,
      '../telemetry': iastTelemetry
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

  describe('taintObject', () => {
    it('Given a null iastContext and null obj should return the object', () => {
      const obj = null

      const result = taintTrackingOperations.taintObject(null, obj, null)
      expect(taintedUtilsMock.newTaintedString).not.to.have.been.called
      expect(result).to.equal(obj)
    })

    it('Given a null iastContext should return the object', () => {
      const obj = {}

      const result = taintTrackingOperations.taintObject(null, obj, null)
      expect(taintedUtilsMock.newTaintedString).not.to.have.been.called
      expect(result).to.equal(obj)
    })

    it('Given an undefined iastContext should return the object', () => {
      const obj = {}

      const result = taintTrackingOperations.taintObject(undefined, obj, null)
      expect(taintedUtilsMock.newTaintedString).not.to.have.been.called
      expect(result).to.equal(obj)
    })

    it('Given an undefined iastContext and undefined object should return the object', () => {
      const obj = undefined

      const result = taintTrackingOperations.taintObject(undefined, obj, null)
      expect(taintedUtilsMock.newTaintedString).not.to.have.been.called
      expect(result).to.equal(obj)
    })

    it('Given a valid iastContext and empty object should return the object', () => {
      const iastContext = {}
      const transactionId = 'id'
      taintTrackingOperations.createTransaction(transactionId, iastContext)
      const obj = {}

      const result = taintTrackingOperations.taintObject(null, obj, null)
      expect(taintedUtilsMock.newTaintedString).not.to.have.been.called
      expect(result).to.equal(obj)
    })

    it('Given a valid iastContext and a string should return the string and call newTaintedString', () => {
      const iastContext = {}
      const transactionId = 'id'
      taintTrackingOperations.createTransaction(transactionId, iastContext)
      const obj = 'string'

      const result = taintTrackingOperations.taintObject(iastContext, obj, null)
      expect(taintedUtilsMock.newTaintedString).to.have.been.calledOnceWithExactly(transactionId, obj, null, null)
      expect(result).to.equal(obj)
    })

    it('Given a valid iastContext and a complex object should return the obj and call newTaintedString', () => {
      const iastContext = {}
      const transactionId = 'id'
      taintTrackingOperations.createTransaction(transactionId, iastContext)
      const expected = {
        value: 'parent',
        child: {
          value: 'child'
        }
      }
      const obj = {
        value: 'parent',
        child: {
          value: 'child'
        }
      }

      const result = taintTrackingOperations.taintObject(iastContext, obj, null)
      expect(taintedUtilsMock.newTaintedString).to.have.been.calledTwice
      expect(taintedUtilsMock.newTaintedString.firstCall).to.have.been
        .calledWithExactly(transactionId, 'child', 'child.value', null)
      expect(taintedUtilsMock.newTaintedString.secondCall).to.have.been
        .calledWithExactly(transactionId, 'parent', 'value', null)
      expect(result).to.be.deep.equal(expected)
    })

    it('Should call newTaintedString in object keys when keyTainting is true', () => {
      const iastContext = {}
      const transactionId = 'id'
      taintTrackingOperations.createTransaction(transactionId, iastContext)

      const VALUE_TYPE = 'value.type'
      const KEY_TYPE = 'key.type'

      const obj = {
        key1: 'parent',
        key2: {
          key3: 'child'
        }
      }

      const result = taintTrackingOperations.taintObject(iastContext, obj, VALUE_TYPE, true, KEY_TYPE)
      expect(taintedUtilsMock.newTaintedString.getCall(0)).to.have.been
        .calledWithExactly(transactionId, 'key2', 'key2', KEY_TYPE)
      expect(taintedUtilsMock.newTaintedString.getCall(1)).to.have.been
        .calledWithExactly(transactionId, 'child', 'key2.key3', VALUE_TYPE)
      expect(taintedUtilsMock.newTaintedString.getCall(2)).to.have.been
        .calledWithExactly(transactionId, 'key3', 'key2.key3', KEY_TYPE)
      expect(taintedUtilsMock.newTaintedString.getCall(3)).to.have.been
        .calledWithExactly(transactionId, 'parent', 'key1', VALUE_TYPE)
      expect(taintedUtilsMock.newTaintedString.getCall(4)).to.have.been
        .calledWithExactly(transactionId, 'key1', 'key1', KEY_TYPE)
      expect(result).to.equal(obj)

      taintTrackingOperations.removeTransaction()
    })

    it('Should taint object keys when taintingKeys is true', () => {
      const taintTrackingOperations = require('../../../../src/appsec/iast/taint-tracking/operations')
      const iastContext = {}
      const transactionId = 'id'
      taintTrackingOperations.createTransaction(transactionId, iastContext)

      const VALUE_TYPE = 'value.type'
      const KEY_TYPE = 'key.type'

      const obj = {
        keyLargerThan10Chars: 'parent',
        anotherKeyLargerThan10Chars: {
          shortKey: 'child'
        }
      }

      const checkValueAndKeyAreTainted = (target, key) => {
        // Strings shorter than 10 characters are not tainted directly, but a new instance of the string is created
        // in dd-native-iast-taint-tracking. This leads to object keys that meet this condition not being detected
        // as tainted
        if (key && key.length >= 10) {
          const isKeyTainted = taintTrackingOperations.isTainted(iastContext, key)
          expect(isKeyTainted).to.be.true
        }

        const obj = key ? target[key] : target
        if (!key || typeof obj === 'object') {
          Object.keys(obj).forEach(k => checkValueAndKeyAreTainted(obj, k))
        } else if (typeof obj === 'string') {
          const isValueTainted = taintTrackingOperations.isTainted(iastContext, obj)
          expect(isValueTainted).to.be.true
        }
      }

      taintTrackingOperations.taintObject(iastContext, obj, VALUE_TYPE, true, KEY_TYPE)
      checkValueAndKeyAreTainted(obj, null)
    })

    it('Should handle the exception', () => {
      const iastContext = {}
      const transactionId = 'id'
      const obj = 'string'
      const taintedUtils = {
        newTaintedString: id => { throw new Error() },
        trim: id => id
      }

      const iastLogStub = {
        error (data) { return this },
        errorAndPublish (data) { return this }
      }

      const logSpy = sinon.spy(iastLogStub)
      const taintTrackingOperations = proxyquire('../../../../src/appsec/iast/taint-tracking/operations', {
        '@datadog/native-iast-taint-tracking': taintedUtils,
        '../../../../../datadog-core': datadogCore,
        '../iast-log': logSpy,
        './taint-tracking-impl': taintTrackingImpl
      })

      taintTrackingOperations.createTransaction(transactionId, iastContext)
      const result = taintTrackingOperations.taintObject(iastContext, obj, null)
      expect(logSpy.error).to.have.been.calledOnce
      expect(logSpy.errorAndPublish).to.have.been.calledOnce
      expect(result).to.equal(obj)
    })
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

    it('Should increment REQUEST_TAINTED metric if INFORMATION or greater verbosity is enabled', () => {
      const iastContext = {
        [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id'
      }
      iastTelemetry.configure({
        telemetry: { enabled: true, metrics: true }
      }, 'INFORMATION')

      const requestTaintedAdd = sinon.stub(REQUEST_TAINTED, 'add')

      taintTrackingOperations.enableTaintOperations(iastTelemetry.verbosity)
      taintTrackingOperations.removeTransaction(iastContext)

      expect(requestTaintedAdd).to.be.calledOnceWith(5, null, iastContext)
    })
  })

  describe('SetMaxTransactions', () => {
    it('Given a number of concurrent transactions should call setMaxTransactions', () => {
      const transactions = 3

      taintTrackingOperations.setMaxTransactions(transactions)
      expect(taintedUtils.setMaxTransactions).to.have.been.calledOnceWithExactly(transactions)
    })

    it('Given undefined as a number of concurrent transactions should not call setMaxTransactions', () => {
      taintTrackingOperations.setMaxTransactions()
      expect(taintedUtils.setMaxTransactions).not.to.have.been.called
    })
  })

  describe('enableTaintTracking', () => {
    let context
    beforeEach(() => {
      context = { [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id' }
      iastContextFunctions.saveIastContext(
        store,
        {},
        context
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

    it('Should set debug global._ddiast object', () => {
      taintTrackingOperations.enableTaintOperations(Verbosity.DEBUG)

      // dummy taintedUtils is declared in global scope
      expect(global._ddiast).not.to.be.undefined
      expect(global._ddiast.plusOperator).not.to.be.undefined

      const executedPropagationIncrease = sinon.stub(EXECUTED_PROPAGATION, 'inc')

      // taintedUtils methods are not called
      global._ddiast.plusOperator('helloworld', 'hello', 'world')
      expect(taintedUtils.concat).to.be.called

      expect(executedPropagationIncrease).to.be.calledOnceWith(null, context)
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

  describe('trim', () => {
    beforeEach(() => {
      iastContextFunctions.saveIastContext(store, {}, { [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id' })
      taintTrackingOperations.enableTaintOperations()
    })

    it('Should call taintedUtils.trim method', () => {
      const a = 'hello   '
      const fn = a.trim
      global._ddiast.trim(fn.call(a), fn, a)
      expect(taintedUtils.trim).to.be.called
    })

    it('Should call taintedUtils.trimStart method', () => {
      const a = 'hello   '
      const fn = a.trimStart
      global._ddiast.trim(fn.call(a), fn, a)
      expect(taintedUtils.trim).to.be.called
    })

    it('Should call taintedUtils.trimEnd method', () => {
      const a = 'hello   '
      const fn = a.trimEnd
      global._ddiast.trimEnd(fn.call(a), fn, a)
      expect(taintedUtils.trimEnd).to.be.called
    })

    it('Should not call taintedUtils.trim method if invoked trim is not from an string', () => {
      const a = { trim: function (a) { return a } }
      const fn = a.trim
      const result = global._ddiast.trim(fn.call(a, 'hello'), fn, a, 'hello')
      expect(taintedUtils.trim).not.to.be.called
      expect(result).eq('hello')
    })

    it('Should not call taintedUtils.trim method if there is not an active transaction', () => {
      iastContextFunctions.saveIastContext(store, {}, { [taintTrackingOperations.IAST_TRANSACTION_ID]: null })
      const a = 'hello   '
      const fn = a.trim
      global._ddiast.trim(fn.call(a), fn, a)
      expect(taintedUtils.trim).not.to.be.called
    })

    it('Should not call taintedUtils.trim method if an Error happens', () => {
      const datadogCoreErr = {
        storage: {
          getStore: () => { throw new Error() }
        }
      }
      const taintTrackingImpl = proxyquire('../../../../src/appsec/iast/taint-tracking/taint-tracking-impl', {
        '@datadog/native-iast-taint-tracking': taintedUtilsMock,
        '../../../../../datadog-core': datadogCoreErr
      })
      const taintTrackingOperations = proxyquire('../../../../src/appsec/iast/taint-tracking/operations', {
        '@datadog/native-iast-taint-tracking': taintedUtilsMock,
        '../../../../../datadog-core': datadogCoreErr,
        './taint-tracking-impl': taintTrackingImpl
      })

      iastContextFunctions.saveIastContext(store, {}, { [taintTrackingOperations.IAST_TRANSACTION_ID]: 'id' })
      taintTrackingOperations.enableTaintOperations()

      const a = 'hello   '
      const fn = a.trim
      const result = global._ddiast.trim(fn.call(a), fn, a)
      expect(taintedUtils.trim).not.to.be.called
      expect(result).eq(a.trim())
    })
  })

  describe('TaintTrackingNoop', () => {
    it('should have the same properties as TaintTracking', () => {
      const tt = taintTrackingImpl.getTaintTrackingImpl()
      const noop = taintTrackingImpl.getTaintTrackingNoop()

      expect(noop).to.have.all.keys(Object.keys(tt))
    })

    it('should have the same properties as TaintTrackingDebug', () => {
      const ttDebug = taintTrackingImpl.getTaintTrackingImpl(Verbosity.DEBUG)
      const noop = taintTrackingImpl.getTaintTrackingNoop()

      expect(noop).to.have.all.keys(Object.keys(ttDebug))
    })

    it('should have the same properties as csiMethods', () => {
      const tt = taintTrackingImpl.getTaintTrackingImpl()

      const csiExpectedMethods = getExpectedMethods()

      expect(tt).to.have.all.keys(csiExpectedMethods)
    })
  })
})

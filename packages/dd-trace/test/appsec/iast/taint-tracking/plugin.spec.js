'use strict'

const proxyquire = require('proxyquire')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const taintTrackingOperations = require('../../../../src/appsec/iast/taint-tracking/operations')
const { createTransaction, removeTransaction } = require('../../../../src/appsec/iast/taint-tracking')

describe('IAST Taint tracking plugin', () => {
  let taintTrackingPlugin
  let iastContext

  const store = {}

  const datadogCore = {
    storage: {
      getStore: () => store
    }
  }

  beforeEach(() => {
    taintTrackingPlugin = proxyquire('../../../../src/appsec/iast/taint-tracking/plugin', {
      './operations': sinon.spy(taintTrackingOperations),
      '../../../../../datadog-core': datadogCore
    })

    iastContext = {}
    const transactionId = 'TRANSACTION_ID'
    createTransaction(transactionId, iastContext)
  })

  afterEach(() => {
    removeTransaction(iastContext)
    sinon.restore()
  })

  it('Should subscribe to body parser, qs and cookie channel', () => {
    expect(taintTrackingPlugin._subscriptions).to.have.lengthOf(4)
    expect(taintTrackingPlugin._subscriptions[0]._channel.name).to.equals('datadog:body-parser:read:finish')
    expect(taintTrackingPlugin._subscriptions[1]._channel.name).to.equals('datadog:qs:parse:finish')
    expect(taintTrackingPlugin._subscriptions[2]._channel.name).to.equals('datadog:cookie:parse:finish')
    expect(taintTrackingPlugin._subscriptions[3]._channel.name).to.equals('apm:express:middleware:enter')
  })

  it('Should taint full object', () => {
    const originType = 'ORIGIN_TYPE'
    const objToBeTainted = {
      foo: {
        bar: 'taintValue'
      }
    }

    iastContextFunctions.saveIastContext(
      store,
      {},
      iastContext
    )

    taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted)
    expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(iastContext, objToBeTainted, originType)
  })

  it('Should taint property in object', () => {
    const originType = 'ORIGIN_TYPE'
    const propertyToBeTainted = 'foo'
    const objToBeTainted = {
      [propertyToBeTainted]: {
        bar: 'taintValue'
      }
    }

    iastContextFunctions.saveIastContext(
      store,
      {},
      iastContext
    )

    taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted, propertyToBeTainted)
    expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
      iastContext,
      objToBeTainted[propertyToBeTainted],
      originType
    )
  })

  it('Should not taint non-existing property in object', () => {
    const originType = 'ORIGIN_TYPE'
    const propertyToBeTainted = 'foo'
    const nonExistingProperty = 'non-existing'
    const objToBeTainted = {
      [propertyToBeTainted]: {
        bar: 'taintValue'
      }
    }

    iastContextFunctions.saveIastContext(
      store,
      {},
      iastContext
    )

    taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted, nonExistingProperty)
    expect(taintTrackingOperations.taintObject).to.not.be.called
  })

  it('Should taint property in object with circular refs', () => {
    const originType = 'ORIGIN_TYPE'
    const propertyToBeTainted = 'foo'
    const objToBeTainted = {
      [propertyToBeTainted]: {
        bar: 'taintValue'
      }
    }

    objToBeTainted[propertyToBeTainted].self = objToBeTainted

    iastContextFunctions.saveIastContext(
      store,
      {},
      iastContext
    )

    taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted, propertyToBeTainted)
    expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
      iastContext,
      objToBeTainted[propertyToBeTainted],
      originType
    )
  })

  it('Should non fail on null value', () => {
    const originType = 'ORIGIN_TYPE'
    const propertyToBeTainted = 'invalid'
    const objToBeTainted = {
      [propertyToBeTainted]: null
    }

    iastContextFunctions.saveIastContext(
      store,
      {},
      iastContext
    )

    taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted)
    expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
      iastContext,
      objToBeTainted,
      originType
    )
  })
})

'use strict'

const proxyquire = require('proxyquire')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')

describe('IAST Taint tracking plugin', () => {
  let taintTrackingPlugin
  let taintTrackingOperations

  const store = {}

  const datadogCore = {
    storage: {
      getStore: () => store
    }
  }

  beforeEach(() => {
    taintTrackingOperations = {
      taintObject: sinon.stub().returnsArg(1)
    }
    taintTrackingPlugin = proxyquire('../../../../src/appsec/iast/taint-tracking/plugin', {
      './operations': taintTrackingOperations,
      '../../../../../datadog-core': datadogCore
    })
  })

  afterEach(sinon.restore)

  it('Should subscribe to body parser, qs and cookie channel', () => {
    expect(taintTrackingPlugin._subscriptions).to.have.lengthOf(4)
    expect(taintTrackingPlugin._subscriptions[0]._channel.name).to.equals('datadog:body-parser:read:finish')
    expect(taintTrackingPlugin._subscriptions[1]._channel.name).to.equals('datadog:qs:parse:finish')
    expect(taintTrackingPlugin._subscriptions[2]._channel.name).to.equals('datadog:cookie:parse:finish')
    expect(taintTrackingPlugin._subscriptions[3]._channel.name).to.equals('apm:express:middleware:enter')
  })

  it('Should taint full object', () => {
    const transactionId = 'TRANSACTION_ID'
    const iastContext = { [taintTrackingOperations.IAST_TRANSACTION_ID]: transactionId }
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
    const transactionId = 'TRANSACTION_ID'
    const iastContext = { [taintTrackingOperations.IAST_TRANSACTION_ID]: transactionId }
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

  it('Should taint property in object with circular refs', () => {
    const transactionId = 'TRANSACTION_ID'
    const iastContext = { [taintTrackingOperations.IAST_TRANSACTION_ID]: transactionId }
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
    const transactionId = 'TRANSACTION_ID'
    const iastContext = { [taintTrackingOperations.IAST_TRANSACTION_ID]: transactionId }
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

    taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted, propertyToBeTainted)
    expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
      iastContext,
      objToBeTainted[propertyToBeTainted],
      originType
    )
  })
})

'use strict'

require('../../../../../dd-trace/test/setup/tap')

const proxyquire = require('proxyquire')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const taintTrackingOperations = require('../../../../src/appsec/iast/taint-tracking/operations')

describe('IAST Taint tracking plugin', () => {
  let taintTrackingPlugin

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
  })

  afterEach(() => { sinon.restore() })

  it('Should subscribe to body parser and qs channel', () => {
    expect(taintTrackingPlugin._subscriptions).to.have.lengthOf(2)
    expect(taintTrackingPlugin._subscriptions[0]._channel.name).to.equals('datadog:body-parser:read:finish')
    expect(taintTrackingPlugin._subscriptions[1]._channel.name).to.equals('datadog:qs:parse:finish')
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
})

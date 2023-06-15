'use strict'

const proxyquire = require('proxyquire')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const taintTrackingOperations = require('../../../../src/appsec/iast/taint-tracking/operations')
const dc = require('../../../../../diagnostics_channel')
const {
  HTTP_REQUEST_COOKIE_VALUE,
  HTTP_REQUEST_COOKIE_NAME
} = require('../../../../src/appsec/iast/taint-tracking/origin-types')

const middlewareNextChannel = dc.channel('apm:express:middleware:next')
const queryParseFinishChannel = dc.channel('datadog:qs:parse:finish')
const bodyParserFinishChannel = dc.channel('datadog:body-parser:read:finish')
const cookieParseFinishCh = dc.channel('datadog:cookie:parse:finish')

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
    taintTrackingPlugin.enable()
  })

  afterEach(() => {
    taintTrackingPlugin.disable()
    sinon.restore()
  })

  it('Should subscribe to body parser, qs and cookie channel', () => {
    expect(taintTrackingPlugin._subscriptions).to.have.lengthOf(4)
    expect(taintTrackingPlugin._subscriptions[0]._channel.name).to.equals('datadog:body-parser:read:finish')
    expect(taintTrackingPlugin._subscriptions[1]._channel.name).to.equals('datadog:qs:parse:finish')
    expect(taintTrackingPlugin._subscriptions[2]._channel.name).to.equals('apm:express:middleware:next')
    expect(taintTrackingPlugin._subscriptions[3]._channel.name).to.equals('datadog:cookie:parse:finish')
  })

  describe('taint sources', () => {
    const transactionId = 'TRANSACTION_ID'
    const originType = 'ORIGIN_TYPE'
    let iastContext

    beforeEach(() => {
      iastContext = { [taintTrackingOperations.IAST_TRANSACTION_ID]: transactionId }

      iastContextFunctions.saveIastContext(
        store,
        {},
        iastContext
      )
    })

    afterEach(() => {
      taintTrackingOperations.removeTransaction(iastContext)
    })

    it('Should taint full object', () => {
      const originType = 'ORIGIN_TYPE'
      const objToBeTainted = {
        foo: {
          bar: 'taintValue'
        }
      }

      taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted)
      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(iastContext, objToBeTainted, originType)
    })

    it('Should taint property in object', () => {
      const propertyToBeTainted = 'foo'
      const objToBeTainted = {
        [propertyToBeTainted]: {
          bar: 'taintValue'
        }
      }

      taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted, propertyToBeTainted)
      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        objToBeTainted[propertyToBeTainted],
        originType
      )
    })

    it('Should taint property in object with circular refs', () => {
      const propertyToBeTainted = 'foo'
      const objToBeTainted = {
        [propertyToBeTainted]: {
          bar: 'taintValue'
        }
      }

      objToBeTainted[propertyToBeTainted].self = objToBeTainted

      taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted, propertyToBeTainted)
      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        objToBeTainted[propertyToBeTainted],
        originType
      )
    })

    it('Should non fail on null value', () => {
      const propertyToBeTainted = 'invalid'
      const objToBeTainted = {
        [propertyToBeTainted]: null
      }

      taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted, propertyToBeTainted)
      expect(taintTrackingOperations.taintObject).not.to.be.called
    })

    it('Should taint request parameter when qs event is published', () => {
      const req = {
        query: {
          bar: 'taintValue'
        }
      }

      queryParseFinishChannel.publish({ qs: req.query })

      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        req.query,
        'http.request.parameter'
      )
    })

    it('Should taint request body when body-parser event is published', () => {
      const req = {
        body: {
          bar: 'taintValue'
        }
      }

      bodyParserFinishChannel.publish({ req })

      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        req.body,
        'http.request.body'
      )
    })

    it('Should taint request body when express middleware next event is published', () => {
      const req = {
        body: {
          bar: 'taintValue'
        }
      }

      middlewareNextChannel.publish({ req })

      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        req.body,
        'http.request.body'
      )
    })

    it('Should taint request body only once when bodyparser and express events are published', () => {
      const req = {
        body: {
          bar: 'taintValue'
        }
      }

      bodyParserFinishChannel.publish({ req })
      middlewareNextChannel.publish({ req })
      bodyParserFinishChannel.publish({ req })

      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        req.body,
        'http.request.body'
      )
    })

    it('Should taint cookies when cookie parser event is published', () => {
      const cookies = {
        cookie1: 'tainted_cookie'
      }

      cookieParseFinishCh.publish({ cookies })

      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        cookies,
        HTTP_REQUEST_COOKIE_VALUE,
        true,
        HTTP_REQUEST_COOKIE_NAME
      )
    })
  })
})

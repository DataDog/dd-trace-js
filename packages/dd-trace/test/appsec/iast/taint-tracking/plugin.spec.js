'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const taintTrackingOperations = require('../../../../src/appsec/iast/taint-tracking/operations')
const {
  HTTP_REQUEST_COOKIE_VALUE,
  HTTP_REQUEST_HEADER_VALUE,
  HTTP_REQUEST_PATH_PARAM,
  HTTP_REQUEST_URI,
  SQL_ROW_VALUE
} = require('../../../../src/appsec/iast/taint-tracking/source-types')
const { getConfigFresh } = require('../../../helpers/config')

const middlewareNextChannel = dc.channel('apm:express:middleware:next')
const queryReadFinishChannel = dc.channel('datadog:query:read:finish')
const bodyParserFinishChannel = dc.channel('datadog:body-parser:read:finish')
const cookieParseFinishCh = dc.channel('datadog:cookie:parse:finish')
const processParamsStartCh = dc.channel('datadog:express:process_params:start')
const routerParamStartCh = dc.channel('datadog:router:param:start')
const sequelizeFinish = dc.channel('datadog:sequelize:query:finish')

describe('IAST Taint tracking plugin', () => {
  let taintTrackingPlugin

  const store = {}

  const datadogCore = {
    storage: () => {
      return {
        getStore: () => store
      }
    }
  }

  beforeEach(() => {
    taintTrackingPlugin = proxyquire('../../../../src/appsec/iast/taint-tracking/plugin', {
      './operations': sinon.spy(taintTrackingOperations),
      '../../../../../datadog-core': datadogCore
    })
    const config = getConfigFresh()
    taintTrackingPlugin.enable(config.iast)
  })

  afterEach(() => {
    taintTrackingPlugin.disable()
    sinon.restore()
  })

  it('Should subscribe to body parser, qs, cookie and process_params channel', () => {
    assert.strictEqual(taintTrackingPlugin._subscriptions.length, 17)
    let i = 0
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:body-parser:read:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:multer:read:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:fastify:body-parser:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'apm:express:middleware:next')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:query:read:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:fastify:query-params:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:express:query:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:cookie:parse:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:fastify-cookie:read:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:sequelize:query:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'apm:pg:query:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:express:process_params:start')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:router:param:start')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:fastify:path-params:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'apm:graphql:resolve:start')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:url:parse:finish')
    assert.strictEqual(taintTrackingPlugin._subscriptions[i++]._channel.name, 'datadog:url:getter:finish')
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
      sinon.assert.calledOnceWithExactly(taintTrackingOperations.taintObject, iastContext, objToBeTainted, originType)
    })

    it('Should taint property in object', () => {
      const propertyToBeTainted = 'foo'
      const objToBeTainted = {
        [propertyToBeTainted]: {
          bar: 'taintValue'
        }
      }

      taintTrackingPlugin._taintTrackingHandler(originType, objToBeTainted, propertyToBeTainted)
      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
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
      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
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
      sinon.assert.notCalled(taintTrackingOperations.taintObject)
    })

    it('Should taint request parameter when qs event is published', () => {
      const req = {
        query: {
          bar: 'taintValue'
        }
      }

      queryReadFinishChannel.publish({ query: req.query })

      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
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

      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
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

      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
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

      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
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

      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
        iastContext,
        cookies,
        HTTP_REQUEST_COOKIE_VALUE
      )
    })

    it('Should taint request params when process params event is published with processParamsStartCh', () => {
      const req = {
        params: {
          parameter1: 'tainted1'
        }
      }

      processParamsStartCh.publish({ req })
      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
        iastContext,
        req.params,
        HTTP_REQUEST_PATH_PARAM
      )
    })

    it('Should taint request params when process params event is published with routerParamStartCh', () => {
      const req = {
        params: {
          parameter1: 'tainted1'
        }
      }

      routerParamStartCh.publish({ req })
      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
        iastContext,
        req.params,
        HTTP_REQUEST_PATH_PARAM
      )
    })

    it('Should not taint request params when process params event is published with non params request', () => {
      const req = {}

      processParamsStartCh.publish({ req })
      sinon.assert.notCalled(taintTrackingOperations.taintObject)
    })

    it('Should taint headers and uri from request', () => {
      const req = {
        headers: {
          'x-iast-header': 'header-value'
        },
        url: 'https://testurl'
      }
      taintTrackingPlugin.taintRequest(req, iastContext)

      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.taintObject,
        iastContext,
        req.headers,
        HTTP_REQUEST_HEADER_VALUE
      )

      sinon.assert.calledOnceWithExactly(
        taintTrackingOperations.newTaintedString,
        iastContext,
        req.url,
        HTTP_REQUEST_URI,
        HTTP_REQUEST_URI
      )
    })

    describe('taint database sources', () => {
      it('Should not taint if config is set to 0', () => {
        taintTrackingPlugin.disable()
        const config = getConfigFresh()
        config.dbRowsToTaint = 0
        taintTrackingPlugin.enable(config)

        const result = [
          {
            id: 1,
            name: 'string value 1'
          },
          {
            id: 2,
            name: 'string value 2'
          }]
        sequelizeFinish.publish({ result })

        sinon.assert.notCalled(taintTrackingOperations.newTaintedString)
      })

      describe('with default config', () => {
        it('Should taint first database row coming from sequelize', () => {
          const result = [
            {
              id: 1,
              name: 'string value 1'
            },
            {
              id: 2,
              name: 'string value 2'
            }]
          sequelizeFinish.publish({ result })

          sinon.assert.calledOnceWithExactly(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'string value 1',
            '0.name',
            SQL_ROW_VALUE
          )
        })

        it('Should taint whole object', () => {
          const result = { id: 1, description: 'value' }
          sequelizeFinish.publish({ result })

          sinon.assert.calledOnceWithExactly(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'value',
            'description',
            SQL_ROW_VALUE
          )
        })

        it('Should taint first row in nested objects', () => {
          const result = [
            {
              id: 1,
              description: 'value',
              children: [
                {
                  id: 11,
                  name: 'child1'
                },
                {
                  id: 12,
                  name: 'child2'
                }
              ]
            },
            {
              id: 2,
              description: 'value',
              children: [
                {
                  id: 21,
                  name: 'child3'
                },
                {
                  id: 22,
                  name: 'child4'
                }
              ]
            }
          ]
          sequelizeFinish.publish({ result })

          sinon.assert.calledTwice(taintTrackingOperations.newTaintedString)
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'value',
            '0.description',
            SQL_ROW_VALUE
          )
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'child1',
            '0.children.0.name',
            SQL_ROW_VALUE
          )
        })
      })

      describe('with config set to 2', () => {
        beforeEach(() => {
          taintTrackingPlugin.disable()
          const config = getConfigFresh()
          config.dbRowsToTaint = 2
          taintTrackingPlugin.enable(config)
        })

        it('Should taint first database row coming from sequelize', () => {
          const result = [
            {
              id: 1,
              name: 'string value 1'
            },
            {
              id: 2,
              name: 'string value 2'
            },
            {
              id: 3,
              name: 'string value 2'
            }]
          sequelizeFinish.publish({ result })

          sinon.assert.calledTwice(taintTrackingOperations.newTaintedString)
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'string value 1',
            '0.name',
            SQL_ROW_VALUE
          )
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'string value 2',
            '1.name',
            SQL_ROW_VALUE
          )
        })

        it('Should taint whole object', () => {
          const result = { id: 1, description: 'value' }
          sequelizeFinish.publish({ result })

          sinon.assert.calledOnceWithExactly(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'value',
            'description',
            SQL_ROW_VALUE
          )
        })

        it('Should taint first row in nested objects', () => {
          const result = [
            {
              id: 1,
              description: 'value',
              children: [
                {
                  id: 11,
                  name: 'child1'
                },
                {
                  id: 12,
                  name: 'child2'
                },
                {
                  id: 13,
                  name: 'child3'
                }
              ]
            },
            {
              id: 2,
              description: 'value2',
              children: [
                {
                  id: 21,
                  name: 'child4'
                },
                {
                  id: 22,
                  name: 'child5'
                },
                {
                  id: 23,
                  name: 'child6'
                }
              ]
            },
            {
              id: 3,
              description: 'value3',
              children: [
                {
                  id: 31,
                  name: 'child7'
                },
                {
                  id: 32,
                  name: 'child8'
                },
                {
                  id: 33,
                  name: 'child9'
                }
              ]
            }
          ]
          sequelizeFinish.publish({ result })

          sinon.assert.callCount(taintTrackingOperations.newTaintedString, 6)
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'value',
            '0.description',
            SQL_ROW_VALUE
          )
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'child1',
            '0.children.0.name',
            SQL_ROW_VALUE
          )
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'child2',
            '0.children.1.name',
            SQL_ROW_VALUE
          )
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'value2',
            '1.description',
            SQL_ROW_VALUE
          )
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'child4',
            '1.children.0.name',
            SQL_ROW_VALUE
          )
          sinon.assert.calledWith(
            taintTrackingOperations.newTaintedString,
            iastContext,
            'child5',
            '1.children.1.name',
            SQL_ROW_VALUE
          )
        })
      })
    })
  })
})

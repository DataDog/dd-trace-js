'use strict'

const proxyquire = require('proxyquire')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const taintTrackingOperations = require('../../../../src/appsec/iast/taint-tracking/operations')
const dc = require('dc-polyfill')
const {
  HTTP_REQUEST_COOKIE_VALUE,
  HTTP_REQUEST_HEADER_VALUE,
  HTTP_REQUEST_PATH_PARAM,
  HTTP_REQUEST_URI,
  SQL_ROW_VALUE
} = require('../../../../src/appsec/iast/taint-tracking/source-types')
const Config = require('../../../../src/config')

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
    const config = new Config()
    taintTrackingPlugin.enable(config.iast)
  })

  afterEach(() => {
    taintTrackingPlugin.disable()
    sinon.restore()
  })

  it('Should subscribe to body parser, qs, cookie and process_params channel', () => {
    expect(taintTrackingPlugin._subscriptions).to.have.lengthOf(16)
    let i = 0
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:body-parser:read:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:multer:read:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:fastify:body-parser:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('apm:express:middleware:next')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:query:read:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:fastify:query-params:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:express:query:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:cookie:parse:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:sequelize:query:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('apm:pg:query:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:express:process_params:start')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:fastify:path-params:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:router:param:start')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('apm:graphql:resolve:start')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:url:parse:finish')
    expect(taintTrackingPlugin._subscriptions[i++]._channel.name).to.equals('datadog:url:getter:finish')
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

      queryReadFinishChannel.publish({ query: req.query })

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
      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
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
      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        req.params,
        HTTP_REQUEST_PATH_PARAM
      )
    })

    it('Should not taint request params when process params event is published with non params request', () => {
      const req = {}

      processParamsStartCh.publish({ req })
      expect(taintTrackingOperations.taintObject).to.not.be.called
    })

    it('Should taint headers and uri from request', () => {
      const req = {
        headers: {
          'x-iast-header': 'header-value'
        },
        url: 'https://testurl'
      }
      taintTrackingPlugin.taintRequest(req, iastContext)

      expect(taintTrackingOperations.taintObject).to.be.calledOnceWith(
        iastContext,
        req.headers,
        HTTP_REQUEST_HEADER_VALUE
      )

      expect(taintTrackingOperations.newTaintedString).to.be.calledOnceWith(
        iastContext,
        req.url,
        HTTP_REQUEST_URI,
        HTTP_REQUEST_URI
      )
    })

    describe('taint database sources', () => {
      it('Should not taint if config is set to 0', () => {
        taintTrackingPlugin.disable()
        const config = new Config()
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

        expect(taintTrackingOperations.newTaintedString).to.not.have.been.called
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

          expect(taintTrackingOperations.newTaintedString).to.be.calledOnceWith(
            iastContext,
            'string value 1',
            '0.name',
            SQL_ROW_VALUE
          )
        })

        it('Should taint whole object', () => {
          const result = { id: 1, description: 'value' }
          sequelizeFinish.publish({ result })

          expect(taintTrackingOperations.newTaintedString).to.be.calledOnceWith(
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

          expect(taintTrackingOperations.newTaintedString).to.be.calledTwice
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
            iastContext,
            'value',
            '0.description',
            SQL_ROW_VALUE
          )
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
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
          const config = new Config()
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

          expect(taintTrackingOperations.newTaintedString).to.be.calledTwice
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
            iastContext,
            'string value 1',
            '0.name',
            SQL_ROW_VALUE
          )
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
            iastContext,
            'string value 2',
            '1.name',
            SQL_ROW_VALUE
          )
        })

        it('Should taint whole object', () => {
          const result = { id: 1, description: 'value' }
          sequelizeFinish.publish({ result })

          expect(taintTrackingOperations.newTaintedString).to.be.calledOnceWith(
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

          expect(taintTrackingOperations.newTaintedString).to.callCount(6)
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
            iastContext,
            'value',
            '0.description',
            SQL_ROW_VALUE
          )
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
            iastContext,
            'child1',
            '0.children.0.name',
            SQL_ROW_VALUE
          )
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
            iastContext,
            'child2',
            '0.children.1.name',
            SQL_ROW_VALUE
          )
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
            iastContext,
            'value2',
            '1.description',
            SQL_ROW_VALUE
          )
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
            iastContext,
            'child4',
            '1.children.0.name',
            SQL_ROW_VALUE
          )
          expect(taintTrackingOperations.newTaintedString).to.be.calledWith(
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

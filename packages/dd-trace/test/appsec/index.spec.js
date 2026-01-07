'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const axios = require('axios')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const appsec = require('../../src/appsec')
const RuleManager = require('../../src/appsec/rule_manager')
const waf = require('../../src/appsec/waf')
const {
  bodyParser,
  cookieParser,
  incomingHttpRequestStart,
  incomingHttpRequestEnd,
  passportVerify,
  passportUser,
  expressSession,
  queryParser,
  nextBodyParsed,
  nextQueryParsed,
  expressProcessParams,
  routerParam,
  responseBody,
  responseWriteHead,
  responseSetHeader
} = require('../../src/appsec/channels')
const Reporter = require('../../src/appsec/reporter')
const agent = require('../plugins/agent')
const blockedTemplate = require('../../src/appsec/blocked_templates')
const { storage } = require('../../../datadog-core')
const telemetryMetrics = require('../../src/telemetry/metrics')
const addresses = require('../../src/appsec/addresses')
const { getConfigFresh } = require('../helpers/config')

const resultActions = {
  actions: {
    block_request: {
      status_code: 401,
      type: 'auto',
      grpc_status_code: 10
    }
  }
}

describe('AppSec Index', function () {
  this.timeout(5000)

  let config
  let AppSec
  let web
  let blocking
  let UserTracking
  let log
  let appsecTelemetry
  let graphql
  let apiSecuritySampler
  let rasp
  let serverless

  const RULES = { rules: [{ a: 1 }] }

  beforeEach(() => {
    config = {
      appsec: {
        enabled: true,
        rules: './path/rules.json',
        rateLimit: 42,
        wafTimeout: 42,
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        blockedTemplateHtml: blockedTemplate.html,
        blockedTemplateJson: blockedTemplate.json,
        eventTracking: {
          mode: 'anon'
        },
        apiSecurity: {
          enabled: false,
          sampleDelay: 10
        },
        rasp: {
          enabled: true,
          bodyCollection: true
        },
        extendedHeadersCollection: {
          enabled: true,
          redaction: false,
          maxHeaders: 42
        }
      }
    }

    web = {
      root: sinon.stub(),
      getContext: sinon.stub(),
      _prioritySampler: {
        isSampled: sinon.stub()
      }
    }

    blocking = {
      setTemplates: sinon.stub(),
      callBlockDelegation: sinon.stub()
    }

    UserTracking = {
      setCollectionMode: sinon.stub(),
      trackLogin: sinon.stub(),
      trackUser: sinon.stub()
    }

    log = {
      debug: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub()
    }

    appsecTelemetry = {
      enable: sinon.stub(),
      disable: sinon.stub()
    }

    graphql = {
      enable: sinon.stub(),
      disable: sinon.stub()
    }

    apiSecuritySampler = proxyquire('../../src/appsec/api_security_sampler', {
      '../plugins/util/web': web
    })
    sinon.spy(apiSecuritySampler, 'sampleRequest')

    rasp = {
      enable: sinon.stub(),
      disable: sinon.stub()
    }

    serverless = {
      isInServerlessEnvironment: sinon.stub()
    }
    serverless.isInServerlessEnvironment.returns(false)

    AppSec = proxyquire('../../src/appsec', {
      '../log': log,
      '../plugins/util/web': web,
      './blocking': blocking,
      './user_tracking': UserTracking,
      './telemetry': appsecTelemetry,
      './graphql': graphql,
      './api_security_sampler': apiSecuritySampler,
      './rasp': rasp,
      '../serverless': serverless
    })

    sinon.stub(fs, 'readFileSync').returns(JSON.stringify(RULES))
    sinon.stub(waf, 'init').callThrough()
    sinon.stub(RuleManager, 'loadRules')
    sinon.stub(Reporter, 'init')
    sinon.stub(incomingHttpRequestStart, 'subscribe')
    sinon.stub(incomingHttpRequestEnd, 'subscribe')
  })

  afterEach(() => {
    sinon.restore()
    AppSec.disable()
  })

  describe('enable', () => {
    it('should enable AppSec only once', () => {
      AppSec.enable(config)
      AppSec.enable(config)

      sinon.assert.calledOnceWithExactly(blocking.setTemplates, config)
      sinon.assert.calledOnceWithExactly(RuleManager.loadRules, config.appsec)
      sinon.assert.calledOnceWithExactly(Reporter.init, config.appsec)
      sinon.assert.calledOnceWithExactly(UserTracking.setCollectionMode, 'anon', false)
      sinon.assert.calledOnceWithExactly(incomingHttpRequestStart.subscribe, AppSec.incomingHttpStartTranslator)
      sinon.assert.calledOnceWithExactly(incomingHttpRequestEnd.subscribe, AppSec.incomingHttpEndTranslator)
      sinon.assert.calledOnce(graphql.enable)
    })

    it('should log when enable fails', () => {
      RuleManager.loadRules.restore()

      const err = new Error('Invalid Rules')
      sinon.stub(RuleManager, 'loadRules').throws(err)

      AppSec.enable(config)

      sinon.assert.calledOnceWithExactly(log.error, '[ASM] Unable to start AppSec', err)
      sinon.assert.notCalled(incomingHttpRequestStart.subscribe)
      sinon.assert.notCalled(incomingHttpRequestEnd.subscribe)
    })

    it('should not log when enable fails in serverless', () => {
      RuleManager.loadRules.restore()

      const err = new Error('Invalid Rules')
      sinon.stub(RuleManager, 'loadRules').throws(err)
      serverless.isInServerlessEnvironment.returns(true)

      AppSec.enable(config)

      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(incomingHttpRequestStart.subscribe)
      sinon.assert.notCalled(incomingHttpRequestEnd.subscribe)
    })

    it('should subscribe to blockable channels', () => {
      assert.strictEqual(bodyParser.hasSubscribers, false)
      assert.strictEqual(cookieParser.hasSubscribers, false)
      assert.strictEqual(passportVerify.hasSubscribers, false)
      assert.strictEqual(passportUser.hasSubscribers, false)
      assert.strictEqual(expressSession.hasSubscribers, false)
      assert.strictEqual(queryParser.hasSubscribers, false)
      assert.strictEqual(nextBodyParsed.hasSubscribers, false)
      assert.strictEqual(nextQueryParsed.hasSubscribers, false)
      assert.strictEqual(expressProcessParams.hasSubscribers, false)
      assert.strictEqual(routerParam.hasSubscribers, false)
      assert.strictEqual(responseWriteHead.hasSubscribers, false)
      assert.strictEqual(responseSetHeader.hasSubscribers, false)

      AppSec.enable(config)

      assert.strictEqual(bodyParser.hasSubscribers, true)
      assert.strictEqual(cookieParser.hasSubscribers, true)
      assert.strictEqual(passportVerify.hasSubscribers, true)
      assert.strictEqual(passportUser.hasSubscribers, true)
      assert.strictEqual(expressSession.hasSubscribers, true)
      assert.strictEqual(queryParser.hasSubscribers, true)
      assert.strictEqual(nextBodyParsed.hasSubscribers, true)
      assert.strictEqual(nextQueryParsed.hasSubscribers, true)
      assert.strictEqual(expressProcessParams.hasSubscribers, true)
      assert.strictEqual(routerParam.hasSubscribers, true)
      assert.strictEqual(responseWriteHead.hasSubscribers, true)
      assert.strictEqual(responseSetHeader.hasSubscribers, true)
    })

    it('should still subscribe to passportVerify if eventTracking is disabled', () => {
      config.appsec.eventTracking.mode = 'disabled'

      AppSec.disable()
      AppSec.enable(config)

      assert.strictEqual(passportVerify.hasSubscribers, true)
    })

    it('should call appsec telemetry enable', () => {
      config.telemetry = {
        enabled: true,
        metrics: true
      }
      AppSec.enable(config)

      sinon.assert.calledOnceWithExactly(appsecTelemetry.enable, config)
    })

    it('should call rasp enable', () => {
      AppSec.enable(config)

      sinon.assert.calledOnceWithExactly(rasp.enable, config)
    })

    it('should not call rasp enable when rasp is disabled', () => {
      config.appsec.rasp.enabled = false
      AppSec.enable(config)

      sinon.assert.notCalled(rasp.enable)
    })
  })

  describe('disable', () => {
    it('should disable AppSec', () => {
      // we need real DC for this test
      incomingHttpRequestStart.subscribe.restore()
      incomingHttpRequestEnd.subscribe.restore()

      AppSec.enable(config)

      sinon.stub(RuleManager, 'clearAllRules')
      sinon.spy(incomingHttpRequestStart, 'unsubscribe')
      sinon.spy(incomingHttpRequestEnd, 'unsubscribe')

      AppSec.disable()

      sinon.assert.calledOnce(RuleManager.clearAllRules)
      sinon.assert.calledOnceWithExactly(incomingHttpRequestStart.unsubscribe, AppSec.incomingHttpStartTranslator)
      sinon.assert.calledOnceWithExactly(incomingHttpRequestEnd.unsubscribe, AppSec.incomingHttpEndTranslator)
      sinon.assert.calledOnce(graphql.disable)
      sinon.assert.calledOnce(rasp.disable)
    })

    it('should disable AppSec when DC channels are not active', () => {
      AppSec.enable(config)

      sinon.stub(RuleManager, 'clearAllRules')

      assert.doesNotThrow(AppSec.disable)

      sinon.assert.calledOnce(RuleManager.clearAllRules)
    })

    it('should unsubscribe to blockable channels', () => {
      AppSec.enable(config)

      AppSec.disable()

      assert.strictEqual(bodyParser.hasSubscribers, false)
      assert.strictEqual(cookieParser.hasSubscribers, false)
      assert.strictEqual(passportVerify.hasSubscribers, false)
      assert.strictEqual(passportUser.hasSubscribers, false)
      assert.strictEqual(expressSession.hasSubscribers, false)
      assert.strictEqual(queryParser.hasSubscribers, false)
      assert.strictEqual(nextBodyParsed.hasSubscribers, false)
      assert.strictEqual(nextQueryParsed.hasSubscribers, false)
      assert.strictEqual(expressProcessParams.hasSubscribers, false)
      assert.strictEqual(routerParam.hasSubscribers, false)
      assert.strictEqual(responseWriteHead.hasSubscribers, false)
      assert.strictEqual(responseSetHeader.hasSubscribers, false)
    })

    it('should call appsec telemetry disable', () => {
      AppSec.enable(config)

      AppSec.disable()

      sinon.assert.calledOnce(appsecTelemetry.disable)
    })
  })

  describe('incomingHttpStartTranslator', () => {
    beforeEach(() => {
      AppSec.enable(config)

      sinon.stub(waf, 'run')
    })

    it('should propagate incoming http start data', () => {
      const rootSpan = {
        addTags: sinon.stub()
      }

      web.root.returns(rootSpan)

      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost',
          cookie: 'a=1;b=2'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        }
      }
      const res = {}

      AppSec.incomingHttpStartTranslator({ req, res })

      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        '_dd.appsec.enabled': 1,
        '_dd.runtime_family': 'nodejs',
        'http.client_ip': '127.0.0.1'
      })
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          'server.request.uri.raw': '/path',
          'server.request.headers.no_cookies': { 'user-agent': 'Arachni', host: 'localhost' },
          'server.request.method': 'POST',
          'http.client_ip': '127.0.0.1'
        }
      }, req)
    })
  })

  describe('incomingHttpEndTranslator', () => {
    beforeEach(() => {
      AppSec.enable(config)

      sinon.stub(waf, 'run')

      const rootSpan = {
        addTags: sinon.stub()
      }

      web.root.returns(rootSpan)
    })

    it('should not propagate incoming http end data without express', () => {
      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost',
          cookie: 'a=1;b=2'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        }
      }
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-length': 42
        }),
        statusCode: 201
      }

      web.patch(req)

      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      sinon.assert.notCalled(waf.run)

      sinon.assert.calledOnceWithExactly(Reporter.finishRequest, req, res, {}, undefined)
    })

    it('should pass stored response headers to Reporter.finishRequest', () => {
      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        }
      }
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-length': 42
        }),
        statusCode: 200
      }

      const storedHeaders = {
        'content-type': 'text/plain',
        'content-language': 'en-US',
        'content-length': '15'
      }

      web.patch(req)

      sinon.stub(Reporter, 'finishRequest')
      sinon.stub(waf, 'disposeContext')

      responseWriteHead.publish({
        req,
        res,
        abortController: { abort: sinon.stub() },
        statusCode: 200,
        responseHeaders: storedHeaders
      })

      AppSec.incomingHttpEndTranslator({ req, res })

      sinon.assert.calledOnceWithExactly(Reporter.finishRequest, req, res, storedHeaders, undefined)
    })

    it('should not propagate incoming http end data with invalid framework properties', () => {
      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost',
          cookie: 'a=1;b=2'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        },
        body: null,
        query: 'string',
        route: {},
        params: 'string',
        cookies: 'string'
      }
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-length': 42
        }),
        statusCode: 201
      }

      web.patch(req)

      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      sinon.assert.notCalled(waf.run)

      sinon.assert.calledOnceWithExactly(Reporter.finishRequest, req, res, {}, undefined)
    })

    it('should propagate incoming http end data with express', () => {
      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost',
          cookie: 'a=1;b=2'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        },
        body: {
          a: '1'
        },
        query: {
          b: '2'
        },
        route: {
          path: '/path/:c'
        },
        cookies: {
          d: '4',
          e: '5'
        }
      }
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-length': 42
        }),
        statusCode: 201
      }

      web.patch(req)

      sinon.stub(Reporter, 'finishRequest')
      AppSec.incomingHttpEndTranslator({ req, res })

      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          'server.request.body': { a: '1' },
          'server.request.cookies': { d: '4', e: '5' },
          'server.request.query': { b: '2' }
        }
      }, req)
      sinon.assert.calledOnceWithExactly(Reporter.finishRequest, req, res, {}, req.body)
    })
  })

  describe('Api Security', () => {
    beforeEach(() => {
      sinon.stub(waf, 'run')

      const rootSpan = {
        addTags: sinon.stub()
      }

      web.root.returns(rootSpan)
      web.getContext.returns({ paths: ['path'] })
    })

    it('should not trigger schema extraction with feature disabled', () => {
      config.appsec.apiSecurity = {
        enabled: false,
        sampleDelay: 1
      }

      AppSec.enable(config)

      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost',
          cookie: 'a=1;b=2'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        },
        body: {
          a: '1'
        },
        query: {
          b: '2'
        },
        route: {
          path: '/path/:c'
        }
      }
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-length': 42
        }),
        statusCode: 201
      }

      web.patch(req)

      sinon.stub(Reporter, 'finishRequest')
      AppSec.incomingHttpEndTranslator({ req, res })

      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          'server.request.body': { a: '1' },
          'server.request.query': { b: '2' }
        }
      }, req)
    })

    it('should trigger schema extraction with sampling enabled', () => {
      config.appsec.apiSecurity = {
        enabled: true,
        sampleDelay: 1
      }

      AppSec.enable(config)

      const req = {
        route: {
          path: '/path'
        },
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        },
        body: {
          a: '1'
        }
      }
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-length': 42
        }),
        statusCode: 201
      }

      const span = {
        context: sinon.stub().returns({
          _sampling: {
            priority: 1
          }
        })
      }

      web.root.returns(span)
      web._prioritySampler.isSampled.returns(true)

      AppSec.incomingHttpEndTranslator({ req, res })

      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          'server.request.body': { a: '1' },
          'waf.context.processor': { 'extract-schema': true }
        }
      }, req)
    })

    describe('onResponseBody', () => {
      beforeEach(() => {
        config.appsec.apiSecurity = {
          enabled: true,
          sampleDelay: 1
        }

        AppSec.enable(config)
      })

      afterEach(() => {
        AppSec.disable()
      })

      it('should not do anything if body is not an object', () => {
        responseBody.publish({ req: {}, body: 'string' })
        responseBody.publish({ req: {}, body: null })

        sinon.assert.notCalled(apiSecuritySampler.sampleRequest)
        sinon.assert.notCalled(waf.run)
      })

      it('should not call to the waf if it is not a sampled request', () => {
        apiSecuritySampler.sampleRequest = apiSecuritySampler.sampleRequest.instantiateFake(() => false)
        const req = {}
        const res = {}

        responseBody.publish({ req, res, body: {} })

        sinon.assert.calledOnceWithMatch(apiSecuritySampler.sampleRequest, req, res)
        sinon.assert.notCalled(waf.run)
      })

      it('should call to the waf if it is a sampled request', () => {
        apiSecuritySampler.sampleRequest = apiSecuritySampler.sampleRequest.instantiateFake(() => true)
        const req = {}
        const res = {}
        const body = {}

        responseBody.publish({ req, res, body })

        sinon.assert.calledOnceWithMatch(apiSecuritySampler.sampleRequest, req, res)
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            [addresses.HTTP_INCOMING_RESPONSE_BODY]: body
          }
        }, req)
      })
    })
  })

  describe('Channel handlers', () => {
    let abortController, req, res, rootSpan

    beforeEach(() => {
      sinon.stub(waf, 'run')

      rootSpan = {
        setTag: sinon.stub(),
        _tags: {},
        context: () => ({ _tags: rootSpan._tags })
      }
      web.root.returns(rootSpan)

      abortController = { abort: sinon.stub() }

      res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-length': 42
        }),
        writeHead: sinon.stub(),
        getHeaderNames: sinon.stub().returns([]),
        constructor: {
          prototype: {
            end: sinon.stub()
          }
        }
      }

      req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        },
        res
      }

      AppSec.enable(config)
    })

    describe('onRequestBodyParsed', () => {
      it('Should not block without body', () => {
        bodyParser.publish({ req, res, abortController })

        sinon.assert.notCalled(waf.run)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('Should not block with body by default', () => {
        const body = { key: 'value' }
        req.body = body

        bodyParser.publish({ req, res, body, abortController })

        sinon.assert.calledOnceWithMatch(waf.run, {
          persistent: {
            'server.request.body': { key: 'value' }
          }
        })
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('Should block when it is detected as attack', () => {
        const body = { key: 'value' }
        req.body = body
        waf.run.returns(resultActions)

        bodyParser.publish({ req, res, body, abortController })

        sinon.assert.calledOnceWithMatch(waf.run, {
          persistent: {
            'server.request.body': { key: 'value' }
          }
        })
        sinon.assert.called(abortController.abort)
        sinon.assert.called(res.constructor.prototype.end)
      })
    })

    describe('onRequestCookieParsed', () => {
      it('Should not block without cookie', () => {
        cookieParser.publish({ req, res, abortController })

        sinon.assert.notCalled(waf.run)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('Should not block with cookie by default', () => {
        const cookies = { key: 'value' }

        cookieParser.publish({ req, res, abortController, cookies })

        sinon.assert.calledOnceWithMatch(waf.run, {
          persistent: {
            'server.request.cookies': { key: 'value' }
          }
        })
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('Should block when it is detected as attack', () => {
        const cookies = { key: 'value' }
        waf.run.returns(resultActions)

        cookieParser.publish({ req, res, abortController, cookies })

        sinon.assert.calledOnceWithMatch(waf.run, {
          persistent: {
            'server.request.cookies': { key: 'value' }
          }
        })
        sinon.assert.called(abortController.abort)
        sinon.assert.called(res.constructor.prototype.end)
      })
    })

    describe('onRequestQueryParsed', () => {
      it('Should not block without query', () => {
        queryParser.publish({ req, res, abortController })

        sinon.assert.notCalled(waf.run)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('Should not block with query by default', () => {
        const query = { key: 'value' }
        req.query = query

        queryParser.publish({ req, res, query, abortController })

        sinon.assert.calledOnceWithMatch(waf.run, {
          persistent: {
            'server.request.query': { key: 'value' }
          }
        })
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('Should block when it is detected as attack', () => {
        const query = { key: 'value' }
        req.query = query
        waf.run.returns(resultActions)

        queryParser.publish({ req, res, query, abortController })

        sinon.assert.calledOnceWithMatch(waf.run, {
          persistent: {
            'server.request.query': { key: 'value' }
          }
        })
        sinon.assert.called(abortController.abort)
        sinon.assert.called(res.constructor.prototype.end)
      })
    })

    describe('onPassportVerify', () => {
      beforeEach(() => {
        sinon.stub(storage('legacy'), 'getStore').returns({ req })
      })

      it('should block when UserTracking.trackLogin() returns action', () => {
        UserTracking.trackLogin.returns(resultActions)

        const abortController = new AbortController()
        const payload = {
          framework: 'passport-local',
          login: 'test',
          user: { _id: 1, username: 'test', password: '1234' },
          success: true,
          abortController
        }

        passportVerify.publish(payload)

        sinon.assert.calledOnce(storage('legacy').getStore)
        sinon.assert.calledOnceWithExactly(web.root, req)
        sinon.assert.calledOnceWithExactly(UserTracking.trackLogin,
          payload.framework,
          payload.login,
          payload.user,
          payload.success,
          rootSpan
        )
        assert.strictEqual(abortController.signal.aborted, true)
        sinon.assert.called(res.constructor.prototype.end)
      })

      it('should not block when UserTracking.trackLogin() returns nothing', () => {
        UserTracking.trackLogin.returns(undefined)

        const abortController = new AbortController()
        const payload = {
          framework: 'passport-local',
          login: 'test',
          user: { _id: 1, username: 'test', password: '1234' },
          success: true,
          abortController
        }

        passportVerify.publish(payload)

        sinon.assert.calledOnce(storage('legacy').getStore)
        sinon.assert.calledOnceWithExactly(web.root, req)
        sinon.assert.calledOnceWithExactly(UserTracking.trackLogin,
          payload.framework,
          payload.login,
          payload.user,
          payload.success,
          rootSpan
        )
        assert.strictEqual(abortController.signal.aborted, false)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('should not block and call log if no rootSpan is found', () => {
        storage('legacy').getStore.returns(undefined)

        const abortController = new AbortController()
        const payload = {
          framework: 'passport-local',
          login: 'test',
          user: { _id: 1, username: 'test', password: '1234' },
          success: true,
          abortController
        }

        passportVerify.publish(payload)

        sinon.assert.calledOnce(storage('legacy').getStore)
        sinon.assert.calledOnceWithExactly(log.warn, '[ASM] No rootSpan found in onPassportVerify')
        sinon.assert.notCalled(UserTracking.trackLogin)
        assert.strictEqual(abortController.signal.aborted, false)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })
    })

    describe('onPassportDeserializeUser', () => {
      beforeEach(() => {
        sinon.stub(storage('legacy'), 'getStore').returns({ req })
      })

      it('should block when UserTracking.trackUser() returns action', () => {
        UserTracking.trackUser.returns(resultActions)

        const abortController = new AbortController()
        const payload = {
          user: { _id: 1, username: 'test', password: '1234' },
          abortController
        }

        passportUser.publish(payload)

        sinon.assert.calledOnce(storage('legacy').getStore)
        sinon.assert.calledOnceWithExactly(web.root, req)
        sinon.assert.calledOnceWithExactly(UserTracking.trackUser,
          payload.user,
          rootSpan
        )
        assert.strictEqual(abortController.signal.aborted, true)
        sinon.assert.called(res.constructor.prototype.end)
      })

      it('should not block when UserTracking.trackUser() returns nothing', () => {
        UserTracking.trackUser.returns(undefined)

        const abortController = new AbortController()
        const payload = {
          user: { _id: 1, username: 'test', password: '1234' },
          abortController
        }

        passportUser.publish(payload)

        sinon.assert.calledOnce(storage('legacy').getStore)
        sinon.assert.calledOnceWithExactly(web.root, req)
        sinon.assert.calledOnceWithExactly(UserTracking.trackUser,
          payload.user,
          rootSpan
        )
        assert.strictEqual(abortController.signal.aborted, false)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('should not block and call log if no rootSpan is found', () => {
        storage('legacy').getStore.returns(undefined)

        const abortController = new AbortController()
        const payload = {
          user: { _id: 1, username: 'test', password: '1234' },
          abortController
        }

        passportUser.publish(payload)

        sinon.assert.calledOnce(storage('legacy').getStore)
        sinon.assert.calledOnceWithExactly(log.warn, '[ASM] No rootSpan found in onPassportDeserializeUser')
        sinon.assert.notCalled(UserTracking.trackUser)
        assert.strictEqual(abortController.signal.aborted, false)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })
    })

    describe('onExpressSession', () => {
      it('should not call waf and call log if no rootSpan is found', () => {
        web.root.returns(null)

        expressSession.publish({ req, res, sessionId: '1234', abortController })

        sinon.assert.calledOnceWithExactly(web.root, req)
        sinon.assert.calledOnceWithExactly(log.warn, '[ASM] No rootSpan found in onExpressSession')
        sinon.assert.notCalled(waf.run)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('should not call waf when sessionID was set by SDK', () => {
        rootSpan._tags['usr.session_id'] = 'sdk_sessid'

        expressSession.publish({ req, res, sessionId: '1234', abortController })

        sinon.assert.calledOnceWithExactly(web.root, req)
        sinon.assert.notCalled(log.warn)
        sinon.assert.notCalled(waf.run)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('should call waf and not block with no attack', () => {
        expressSession.publish({ req, res, sessionId: '1234', abortController })

        sinon.assert.calledOnceWithExactly(web.root, req)
        sinon.assert.notCalled(log.warn)
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.session_id': '1234'
          }
        }, req)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('should call waf and block with attack', () => {
        waf.run.returns(resultActions)

        expressSession.publish({ req, res, sessionId: '1234', abortController })

        sinon.assert.calledOnceWithExactly(web.root, req)
        sinon.assert.notCalled(log.warn)
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.session_id': '1234'
          }
        }, req)
        sinon.assert.called(abortController.abort)
        sinon.assert.called(res.constructor.prototype.end)
      })
    })

    describe('onResponseWriteHead', () => {
      it('should call abortController if response was already blocked', () => {
        waf.run.returns(resultActions)

        const responseHeaders = {
          'content-type': 'application/json',
          'content-length': 42,
          'set-cookie': 'a=1;b=2'
        }

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'server.response.status': '404',
            'server.response.headers.no_cookies': {
              'content-type': 'application/json',
              'content-length': 42
            }
          }
        }, req)
        sinon.assert.calledOnce(abortController.abort)
        sinon.assert.calledOnce(res.constructor.prototype.end)
        sinon.assert.calledOnce(blocking.callBlockDelegation)

        abortController.abort.resetHistory()

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        sinon.assert.calledOnce(waf.run)
        sinon.assert.calledOnce(abortController.abort)
        sinon.assert.calledOnce(res.constructor.prototype.end)
        sinon.assert.calledOnce(blocking.callBlockDelegation)
      })

      it('should call abortController if blocking delegate is successful', () => {
        blocking.callBlockDelegation.returns(true)

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders: {} })

        sinon.assert.calledOnceWithExactly(blocking.callBlockDelegation, res)
        sinon.assert.calledOnce(abortController.abort)
        sinon.assert.notCalled(waf.run)
      })

      it('should not call the WAF if response was already analyzed', () => {
        waf.run.returns(null)

        const responseHeaders = {
          'content-type': 'application/json',
          'content-length': 42,
          'set-cookie': 'a=1;b=2'
        }

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'server.response.status': '404',
            'server.response.headers.no_cookies': {
              'content-type': 'application/json',
              'content-length': 42
            }
          }
        }, req)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        sinon.assert.calledOnce(waf.run)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('should not do anything without a root span', () => {
        web.root.returns(null)
        waf.run.returns(null)

        const responseHeaders = {
          'content-type': 'application/json',
          'content-length': 42,
          'set-cookie': 'a=1;b=2'
        }

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        sinon.assert.notCalled(waf.run)
        sinon.assert.notCalled(abortController.abort)
        sinon.assert.notCalled(res.constructor.prototype.end)
      })

      it('should call the WAF with responde code and headers', () => {
        waf.run.returns(resultActions)

        const responseHeaders = {
          'content-type': 'application/json',
          'content-length': 42,
          'set-cookie': 'a=1;b=2'
        }

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'server.response.status': '404',
            'server.response.headers.no_cookies': {
              'content-type': 'application/json',
              'content-length': 42
            }
          }
        }, req)
        sinon.assert.calledOnce(abortController.abort)
        sinon.assert.calledOnce(res.constructor.prototype.end)
      })
    })

    describe('onResponseSetHeader', () => {
      it('should call abortController if response was already blocked', () => {
        // First block the request
        waf.run.returns(resultActions)

        const responseHeaders = {
          'content-type': 'application/json',
          'content-length': 42,
          'set-cookie': 'a=1;b=2'
        }
        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        sinon.assert.calledOnce(abortController.abort)

        abortController.abort.reset()

        responseSetHeader.publish({ res, abortController })

        sinon.assert.calledOnce(abortController.abort)
      })

      it('should not call abortController if response was not blocked', () => {
        responseSetHeader.publish({ res, abortController })

        sinon.assert.notCalled(abortController.abort)
      })
    })
  })

  describe('Metrics', () => {
    const appsecNamespace = telemetryMetrics.manager.namespace('appsec')
    let config

    beforeEach(() => {
      sinon.restore()

      appsecNamespace.reset()

      config = getConfigFresh({
        appsec: {
          enabled: true
        }
      })
    })

    afterEach(() => {
      appsec.disable()
    })

    after(() => {
      appsecNamespace.reset()
    })

    it('should increment waf.init metric', () => {
      config.telemetry.enabled = true
      config.telemetry.metrics = true

      appsec.enable(config)

      const metrics = appsecNamespace.metrics.toJSON()

      assert.strictEqual(metrics.series.length, 1)
      assert.strictEqual(metrics.series[0].metric, 'waf.init')
    })

    it('should not increment waf.init metric if metrics are not enabled', () => {
      config.telemetry.enabled = true
      config.telemetry.metrics = false

      appsec.enable(config)

      const metrics = appsecNamespace.metrics.toJSON()

      assert.strictEqual(metrics, undefined)
    })

    it('should not increment waf.init metric if telemetry is not enabled', () => {
      config.telemetry.enabled = false
      config.telemetry.metrics = true

      appsec.enable(config)

      const metrics = appsecNamespace.metrics.toJSON()

      assert.strictEqual(metrics, undefined)
    })
  })
})

describe('IP blocking', function () {
  this.timeout(5000)

  const invalidIp = '1.2.3.4'
  const validIp = '4.3.2.1'
  const ruleData = {
    rules_data: [{
      data: [
        { value: invalidIp }
      ],
      id: 'blocked_ips',
      type: 'data_with_expiration'
    }]
  }

  const toModify = [{
    product: 'ASM_DATA',
    id: '1',
    path: 'datadog/00/ASM_DATA/test/IP blocking',
    file: ruleData
  }]
  const htmlDefaultContent = blockedTemplate.html
  const jsonDefaultContent = JSON.parse(blockedTemplate.json)

  let http, appListener, port

  function createTransaction (changes) {
    return {
      ...changes,
      ack: sinon.spy(),
      error: sinon.spy()
    }
  }

  before(() => {
    return agent.load('http')
      .then(() => {
        http = require('http')
      })
  })

  before(done => {
    const server = new http.Server((req, res) => {
      res.writeHead(200)
      res.end(JSON.stringify({ message: 'OK' }))
    })
    appListener = server
      .listen(0, 'localhost', () => {
        port = appListener.address().port
        done()
      })
  })

  beforeEach(() => {
    appsec.enable(getConfigFresh({
      appsec: {
        enabled: true,
        rasp: {
          enabled: false // disable rasp to not trigger lfi
        }
      }
    }))

    RuleManager.updateWafFromRC(createTransaction({ toUnapply: [], toApply: [], toModify }))
  })

  afterEach(() => {
    appsec.disable()
  })

  after(() => {
    appListener && appListener.close()
    return agent.close({ ritmReset: false })
  })

  describe('do not block the request', () => {
    it('should not block the request by default', async () => {
      await axios.get(`http://localhost:${port}/`).then((res) => {
        assert.strictEqual(res.status, 200)
      })
    })
  })
  const ipHeaderList = [
    'x-forwarded-for',
    'x-real-ip',
    'client-ip',
    'x-forwarded',
    'x-cluster-client-ip',
    'forwarded-for',
    'forwarded',
    'via',
    'true-client-ip'
  ]
  ipHeaderList.forEach(ipHeader => {
    describe(`not block - ip in header ${ipHeader}`, () => {
      it('should not block the request with valid X-Forwarded-For ip', async () => {
        await axios.get(`http://localhost:${port}/`, {
          headers: {
            [ipHeader]: validIp
          }
        }).then((res) => {
          assert.strictEqual(res.status, 200)
        })
      })
    })

    describe(`block - ip in header ${ipHeader}`, () => {
      it('should block the request with JSON content if no headers', async () => {
        await axios.get(`http://localhost:${port}/`, {
          headers: {
            [ipHeader]: invalidIp
          }
        }).catch((err) => {
          assert.strictEqual(err.response.status, 403)
          assert.deepStrictEqual(err.response.data, jsonDefaultContent)
        })
      })

      it('should block the request with JSON content if accept */*', async () => {
        await axios.get(`http://localhost:${port}/`, {
          headers: {
            [ipHeader]: invalidIp,
            Accept: '*/*'
          }
        }).catch((err) => {
          assert.strictEqual(err.response.status, 403)
          assert.deepStrictEqual(err.response.data, jsonDefaultContent)
        })
      })

      it('should block the request with html content if accept text/html', async () => {
        await axios.get(`http://localhost:${port}/`, {
          headers: {
            [ipHeader]: invalidIp,
            Accept: 'text/html'
          }
        }).catch((err) => {
          assert.strictEqual(err.response.status, 403)
          assert.strictEqual(err.response.data, htmlDefaultContent)
        })
      })
    })
  })

  describe('Custom actions', () => {
    describe('Default content with custom status', () => {
      const toModifyCustomActions = [{
        product: 'ASM',
        id: 'custom-actions',
        path: 'datadog/00/ASM/test/Custom actions/Default content with custom status',
        file: {
          actions: [
            {
              id: 'block',
              type: 'block_request',
              parameters: {
                status_code: 500,
                type: 'auto'
              }
            }
          ]
        }
      }]

      beforeEach(() => {
        RuleManager.updateWafFromRC(createTransaction({
          toUnapply: [],
          toApply: [],
          toModify: [...toModify, ...toModifyCustomActions]
        }))
      })

      afterEach(() => {
        RuleManager.clearAllRules()
      })

      it('Should block with custom status code and JSON content', () => {
        return axios.get(`http://localhost:${port}/`, {
          headers: {
            'x-forwarded-for': invalidIp
          }
        }).then(() => {
          throw new Error('Not expected')
        }).catch((err) => {
          assert.notStrictEqual(err.message, 'Not expected')
          assert.strictEqual(err.response.status, 500)
          assert.deepStrictEqual(err.response.data, jsonDefaultContent)
        })
      })

      it('Should block with custom status code and HTML content', () => {
        return axios.get(`http://localhost:${port}/`, {
          headers: {
            'x-forwarded-for': invalidIp,
            Accept: 'text/html'
          }
        }).then(() => {
          throw new Error('Not expected')
        }).catch((err) => {
          assert.notStrictEqual(err.message, 'Not expected')
          assert.strictEqual(err.response.status, 500)
          assert.deepStrictEqual(err.response.data, htmlDefaultContent)
        })
      })
    })

    describe('Redirect on error', () => {
      const toModifyCustomActions = [{
        product: 'ASM',
        id: 'custom-actions',
        path: 'datadog/00/ASM/test/Custom actions/Redirect on error',
        file: {
          actions: [
            {
              id: 'block',
              type: 'redirect_request',
              parameters: {
                status_code: 301,
                location: '/error'
              }
            }
          ]
        }
      }]

      beforeEach(() => {
        RuleManager.updateWafFromRC(createTransaction({
          toUnapply: [],
          toApply: [],
          toModify: [...toModify, ...toModifyCustomActions]
        }))
      })

      afterEach(() => {
        RuleManager.clearAllRules()
      })

      it('Should block with redirect', () => {
        return axios.get(`http://localhost:${port}/`, {
          headers: {
            'x-forwarded-for': invalidIp
          },
          maxRedirects: 0
        }).then(() => {
          throw new Error('Not resolve expected')
        }).catch((err) => {
          assert.notStrictEqual(err.message, 'Not resolve expected')
          assert.strictEqual(err.response.status, 301)
          assert.strictEqual(err.response.headers.location, '/error')
        })
      })
    })
  })
})

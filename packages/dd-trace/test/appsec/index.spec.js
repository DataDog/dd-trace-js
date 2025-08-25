'use strict'

const fs = require('fs')
const proxyquire = require('proxyquire')
const waf = require('../../src/appsec/waf')
const RuleManager = require('../../src/appsec/rule_manager')
const appsec = require('../../src/appsec')
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
const Config = require('../../src/config')
const axios = require('axios')
const blockedTemplate = require('../../src/appsec/blocked_templates')
const { storage } = require('../../../datadog-core')
const telemetryMetrics = require('../../src/telemetry/metrics')
const addresses = require('../../src/appsec/addresses')

const resultActions = {
  actions: {
    block_request: {
      status_code: '401',
      type: 'auto',
      grpc_status_code: '10'
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
      setTemplates: sinon.stub()
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

      expect(blocking.setTemplates).to.have.been.calledOnceWithExactly(config)
      expect(RuleManager.loadRules).to.have.been.calledOnceWithExactly(config.appsec)
      expect(Reporter.init).to.have.been.calledOnceWithExactly(config.appsec)
      expect(UserTracking.setCollectionMode).to.have.been.calledOnceWithExactly('anon', false)
      expect(incomingHttpRequestStart.subscribe)
        .to.have.been.calledOnceWithExactly(AppSec.incomingHttpStartTranslator)
      expect(incomingHttpRequestEnd.subscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpEndTranslator)
      expect(graphql.enable).to.have.been.calledOnceWithExactly()
    })

    it('should log when enable fails', () => {
      RuleManager.loadRules.restore()

      const err = new Error('Invalid Rules')
      sinon.stub(RuleManager, 'loadRules').throws(err)

      AppSec.enable(config)

      expect(log.error).to.have.been.calledOnceWithExactly('[ASM] Unable to start AppSec', err)
      expect(incomingHttpRequestStart.subscribe).to.not.have.been.called
      expect(incomingHttpRequestEnd.subscribe).to.not.have.been.called
    })

    it('should not log when enable fails in serverless', () => {
      RuleManager.loadRules.restore()

      const err = new Error('Invalid Rules')
      sinon.stub(RuleManager, 'loadRules').throws(err)
      serverless.isInServerlessEnvironment.returns(true)

      AppSec.enable(config)

      expect(log.error).to.not.have.been.called
      expect(incomingHttpRequestStart.subscribe).to.not.have.been.called
      expect(incomingHttpRequestEnd.subscribe).to.not.have.been.called
    })

    it('should subscribe to blockable channels', () => {
      expect(bodyParser.hasSubscribers).to.be.false
      expect(cookieParser.hasSubscribers).to.be.false
      expect(passportVerify.hasSubscribers).to.be.false
      expect(passportUser.hasSubscribers).to.be.false
      expect(expressSession.hasSubscribers).to.be.false
      expect(queryParser.hasSubscribers).to.be.false
      expect(nextBodyParsed.hasSubscribers).to.be.false
      expect(nextQueryParsed.hasSubscribers).to.be.false
      expect(expressProcessParams.hasSubscribers).to.be.false
      expect(routerParam.hasSubscribers).to.be.false
      expect(responseWriteHead.hasSubscribers).to.be.false
      expect(responseSetHeader.hasSubscribers).to.be.false

      AppSec.enable(config)

      expect(bodyParser.hasSubscribers).to.be.true
      expect(cookieParser.hasSubscribers).to.be.true
      expect(passportVerify.hasSubscribers).to.be.true
      expect(passportUser.hasSubscribers).to.be.true
      expect(expressSession.hasSubscribers).to.be.true
      expect(queryParser.hasSubscribers).to.be.true
      expect(nextBodyParsed.hasSubscribers).to.be.true
      expect(nextQueryParsed.hasSubscribers).to.be.true
      expect(expressProcessParams.hasSubscribers).to.be.true
      expect(routerParam.hasSubscribers).to.be.true
      expect(responseWriteHead.hasSubscribers).to.be.true
      expect(responseSetHeader.hasSubscribers).to.be.true
    })

    it('should still subscribe to passportVerify if eventTracking is disabled', () => {
      config.appsec.eventTracking.mode = 'disabled'

      AppSec.disable()
      AppSec.enable(config)

      expect(passportVerify.hasSubscribers).to.be.true
    })

    it('should call appsec telemetry enable', () => {
      config.telemetry = {
        enabled: true,
        metrics: true
      }
      AppSec.enable(config)

      expect(appsecTelemetry.enable).to.be.calledOnceWithExactly(config)
    })

    it('should call rasp enable', () => {
      AppSec.enable(config)

      expect(rasp.enable).to.be.calledOnceWithExactly(config)
    })

    it('should not call rasp enable when rasp is disabled', () => {
      config.appsec.rasp.enabled = false
      AppSec.enable(config)

      expect(rasp.enable).to.not.be.called
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

      expect(RuleManager.clearAllRules).to.have.been.calledOnce
      expect(incomingHttpRequestStart.unsubscribe)
        .to.have.been.calledOnceWithExactly(AppSec.incomingHttpStartTranslator)
      expect(incomingHttpRequestEnd.unsubscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpEndTranslator)
      expect(graphql.disable).to.have.been.calledOnceWithExactly()
      expect(rasp.disable).to.have.been.calledOnceWithExactly()
    })

    it('should disable AppSec when DC channels are not active', () => {
      AppSec.enable(config)

      sinon.stub(RuleManager, 'clearAllRules')

      expect(AppSec.disable).to.not.throw()

      expect(RuleManager.clearAllRules).to.have.been.calledOnce
    })

    it('should unsubscribe to blockable channels', () => {
      AppSec.enable(config)

      AppSec.disable()

      expect(bodyParser.hasSubscribers).to.be.false
      expect(cookieParser.hasSubscribers).to.be.false
      expect(passportVerify.hasSubscribers).to.be.false
      expect(passportUser.hasSubscribers).to.be.false
      expect(expressSession.hasSubscribers).to.be.false
      expect(queryParser.hasSubscribers).to.be.false
      expect(nextBodyParsed.hasSubscribers).to.be.false
      expect(nextQueryParsed.hasSubscribers).to.be.false
      expect(expressProcessParams.hasSubscribers).to.be.false
      expect(routerParam.hasSubscribers).to.be.false
      expect(responseWriteHead.hasSubscribers).to.be.false
      expect(responseSetHeader.hasSubscribers).to.be.false
    })

    it('should call appsec telemetry disable', () => {
      AppSec.enable(config)

      AppSec.disable()

      expect(appsecTelemetry.disable).to.be.calledOnce
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

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        '_dd.appsec.enabled': 1,
        '_dd.runtime_family': 'nodejs',
        'http.client_ip': '127.0.0.1'
      })
      expect(waf.run).to.have.been.calledOnceWithExactly({
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

      expect(waf.run).to.have.not.been.called

      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res, {})
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

      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res, storedHeaders)
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

      expect(waf.run).to.have.not.been.called

      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res, {})
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

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          'server.request.body': { a: '1' },
          'server.request.cookies': { d: '4', e: '5' },
          'server.request.query': { b: '2' }
        }
      }, req)
      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res, {})
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

      expect(waf.run).to.have.been.calledOnceWithExactly({
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

      expect(waf.run).to.have.been.calledOnceWithExactly({
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

        expect(apiSecuritySampler.sampleRequest).to.not.been.called
        expect(waf.run).to.not.been.called
      })

      it('should not call to the waf if it is not a sampled request', () => {
        apiSecuritySampler.sampleRequest = apiSecuritySampler.sampleRequest.instantiateFake(() => false)
        const req = {}
        const res = {}

        responseBody.publish({ req, res, body: {} })

        expect(apiSecuritySampler.sampleRequest).to.have.been.calledOnceWith(req, res)
        expect(waf.run).to.not.been.called
      })

      it('should call to the waf if it is a sampled request', () => {
        apiSecuritySampler.sampleRequest = apiSecuritySampler.sampleRequest.instantiateFake(() => true)
        const req = {}
        const res = {}
        const body = {}

        responseBody.publish({ req, res, body })

        expect(apiSecuritySampler.sampleRequest).to.have.been.calledOnceWith(req, res)
        expect(waf.run).to.have.been.calledOnceWith({
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

        expect(waf.run).not.to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.constructor.prototype.end).not.to.have.been.called
      })

      it('Should not block with body by default', () => {
        const body = { key: 'value' }
        req.body = body

        bodyParser.publish({ req, res, body, abortController })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.body': { key: 'value' }
          }
        })
        expect(abortController.abort).not.to.have.been.called
        expect(res.constructor.prototype.end).not.to.have.been.called
      })

      it('Should block when it is detected as attack', () => {
        const body = { key: 'value' }
        req.body = body
        waf.run.returns(resultActions)

        bodyParser.publish({ req, res, body, abortController })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.body': { key: 'value' }
          }
        })
        expect(abortController.abort).to.have.been.called
        expect(res.constructor.prototype.end).to.have.been.called
      })
    })

    describe('onRequestCookieParsed', () => {
      it('Should not block without cookie', () => {
        cookieParser.publish({ req, res, abortController })

        expect(waf.run).not.to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.constructor.prototype.end).not.to.have.been.called
      })

      it('Should not block with cookie by default', () => {
        const cookies = { key: 'value' }

        cookieParser.publish({ req, res, abortController, cookies })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.cookies': { key: 'value' }
          }
        })
        expect(abortController.abort).not.to.have.been.called
        expect(res.constructor.prototype.end).not.to.have.been.called
      })

      it('Should block when it is detected as attack', () => {
        const cookies = { key: 'value' }
        waf.run.returns(resultActions)

        cookieParser.publish({ req, res, abortController, cookies })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.cookies': { key: 'value' }
          }
        })
        expect(abortController.abort).to.have.been.called
        expect(res.constructor.prototype.end).to.have.been.called
      })
    })

    describe('onRequestQueryParsed', () => {
      it('Should not block without query', () => {
        queryParser.publish({ req, res, abortController })

        expect(waf.run).not.to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.constructor.prototype.end).not.to.have.been.called
      })

      it('Should not block with query by default', () => {
        const query = { key: 'value' }
        req.query = query

        queryParser.publish({ req, res, query, abortController })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.query': { key: 'value' }
          }
        })
        expect(abortController.abort).not.to.have.been.called
        expect(res.constructor.prototype.end).not.to.have.been.called
      })

      it('Should block when it is detected as attack', () => {
        const query = { key: 'value' }
        req.query = query
        waf.run.returns(resultActions)

        queryParser.publish({ req, res, query, abortController })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.query': { key: 'value' }
          }
        })
        expect(abortController.abort).to.have.been.called
        expect(res.constructor.prototype.end).to.have.been.called
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

        expect(storage('legacy').getStore).to.have.been.calledOnce
        expect(web.root).to.have.been.calledOnceWithExactly(req)
        expect(UserTracking.trackLogin).to.have.been.calledOnceWithExactly(
          payload.framework,
          payload.login,
          payload.user,
          payload.success,
          rootSpan
        )
        expect(abortController.signal.aborted).to.be.true
        expect(res.constructor.prototype.end).to.have.been.called
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

        expect(storage('legacy').getStore).to.have.been.calledOnce
        expect(web.root).to.have.been.calledOnceWithExactly(req)
        expect(UserTracking.trackLogin).to.have.been.calledOnceWithExactly(
          payload.framework,
          payload.login,
          payload.user,
          payload.success,
          rootSpan
        )
        expect(abortController.signal.aborted).to.be.false
        expect(res.constructor.prototype.end).to.not.have.been.called
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

        expect(storage('legacy').getStore).to.have.been.calledOnce
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] No rootSpan found in onPassportVerify')
        expect(UserTracking.trackLogin).to.not.have.been.called
        expect(abortController.signal.aborted).to.be.false
        expect(res.constructor.prototype.end).to.not.have.been.called
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

        expect(storage('legacy').getStore).to.have.been.calledOnce
        expect(web.root).to.have.been.calledOnceWithExactly(req)
        expect(UserTracking.trackUser).to.have.been.calledOnceWithExactly(
          payload.user,
          rootSpan
        )
        expect(abortController.signal.aborted).to.be.true
        expect(res.constructor.prototype.end).to.have.been.called
      })

      it('should not block when UserTracking.trackUser() returns nothing', () => {
        UserTracking.trackUser.returns(undefined)

        const abortController = new AbortController()
        const payload = {
          user: { _id: 1, username: 'test', password: '1234' },
          abortController
        }

        passportUser.publish(payload)

        expect(storage('legacy').getStore).to.have.been.calledOnce
        expect(web.root).to.have.been.calledOnceWithExactly(req)
        expect(UserTracking.trackUser).to.have.been.calledOnceWithExactly(
          payload.user,
          rootSpan
        )
        expect(abortController.signal.aborted).to.be.false
        expect(res.constructor.prototype.end).to.not.have.been.called
      })

      it('should not block and call log if no rootSpan is found', () => {
        storage('legacy').getStore.returns(undefined)

        const abortController = new AbortController()
        const payload = {
          user: { _id: 1, username: 'test', password: '1234' },
          abortController
        }

        passportUser.publish(payload)

        expect(storage('legacy').getStore).to.have.been.calledOnce
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] No rootSpan found in onPassportDeserializeUser')
        expect(UserTracking.trackUser).to.not.have.been.called
        expect(abortController.signal.aborted).to.be.false
        expect(res.constructor.prototype.end).to.not.have.been.called
      })
    })

    describe('onExpressSession', () => {
      it('should not call waf and call log if no rootSpan is found', () => {
        web.root.returns(null)

        expressSession.publish({ req, res, sessionId: '1234', abortController })

        expect(web.root).to.have.been.calledOnceWithExactly(req)
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] No rootSpan found in onExpressSession')
        expect(waf.run).to.not.have.been.called
        expect(abortController.abort).to.not.have.been.called
        expect(res.constructor.prototype.end).to.not.have.been.called
      })

      it('should not call waf when sessionID was set by SDK', () => {
        rootSpan._tags['usr.session_id'] = 'sdk_sessid'

        expressSession.publish({ req, res, sessionId: '1234', abortController })

        expect(web.root).to.have.been.calledOnceWithExactly(req)
        expect(log.warn).to.not.have.been.called
        expect(waf.run).to.not.have.been.called
        expect(abortController.abort).to.not.have.been.called
        expect(res.constructor.prototype.end).to.not.have.been.called
      })

      it('should call waf and not block with no attack', () => {
        expressSession.publish({ req, res, sessionId: '1234', abortController })

        expect(web.root).to.have.been.calledOnceWithExactly(req)
        expect(log.warn).to.not.have.been.called
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            'usr.session_id': '1234'
          }
        }, req)
        expect(abortController.abort).to.not.have.been.called
        expect(res.constructor.prototype.end).to.not.have.been.called
      })

      it('should call waf and block with attack', () => {
        waf.run.returns(resultActions)

        expressSession.publish({ req, res, sessionId: '1234', abortController })

        expect(web.root).to.have.been.calledOnceWithExactly(req)
        expect(log.warn).to.not.have.been.called
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            'usr.session_id': '1234'
          }
        }, req)
        expect(abortController.abort).to.have.been.called
        expect(res.constructor.prototype.end).to.have.been.called
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

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            'server.response.status': '404',
            'server.response.headers.no_cookies': {
              'content-type': 'application/json',
              'content-length': 42
            }
          }
        }, req)
        expect(abortController.abort).to.have.been.calledOnce
        expect(res.constructor.prototype.end).to.have.been.calledOnce

        abortController.abort.resetHistory()

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        expect(waf.run).to.have.been.calledOnce
        expect(abortController.abort).to.have.been.calledOnce
        expect(res.constructor.prototype.end).to.have.been.calledOnce
      })

      it('should not call the WAF if response was already analyzed', () => {
        waf.run.returns(null)

        const responseHeaders = {
          'content-type': 'application/json',
          'content-length': 42,
          'set-cookie': 'a=1;b=2'
        }

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            'server.response.status': '404',
            'server.response.headers.no_cookies': {
              'content-type': 'application/json',
              'content-length': 42
            }
          }
        }, req)
        expect(abortController.abort).to.have.not.been.called
        expect(res.constructor.prototype.end).to.have.not.been.called

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        expect(waf.run).to.have.been.calledOnce
        expect(abortController.abort).to.have.not.been.called
        expect(res.constructor.prototype.end).to.have.not.been.called
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

        expect(waf.run).to.have.not.been.called
        expect(abortController.abort).to.have.not.been.called
        expect(res.constructor.prototype.end).to.have.not.been.called
      })

      it('should call the WAF with responde code and headers', () => {
        waf.run.returns(resultActions)

        const responseHeaders = {
          'content-type': 'application/json',
          'content-length': 42,
          'set-cookie': 'a=1;b=2'
        }

        responseWriteHead.publish({ req, res, abortController, statusCode: 404, responseHeaders })

        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            'server.response.status': '404',
            'server.response.headers.no_cookies': {
              'content-type': 'application/json',
              'content-length': 42
            }
          }
        }, req)
        expect(abortController.abort).to.have.been.calledOnce
        expect(res.constructor.prototype.end).to.have.been.calledOnce
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

        expect(abortController.abort).to.have.been.calledOnce

        abortController.abort.reset()

        responseSetHeader.publish({ res, abortController })

        expect(abortController.abort).to.have.been.calledOnce
      })

      it('should not call abortController if response was not blocked', () => {
        responseSetHeader.publish({ res, abortController })

        expect(abortController.abort).to.have.not.been.calledOnce
      })
    })
  })

  describe('Metrics', () => {
    const appsecNamespace = telemetryMetrics.manager.namespace('appsec')
    let config

    beforeEach(() => {
      sinon.restore()

      appsecNamespace.reset()

      config = new Config({
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

      expect(metrics.series.length).to.equal(2)
      expect(metrics.series[0].metric).to.equal('enabled')
      expect(metrics.series[1].metric).to.equal('waf.init')
    })

    it('should not increment waf.init metric if metrics are not enabled', () => {
      config.telemetry.enabled = true
      config.telemetry.metrics = false

      appsec.enable(config)

      const metrics = appsecNamespace.metrics.toJSON()

      expect(metrics).to.be.undefined
    })

    it('should not increment waf.init metric if telemetry is not enabled', () => {
      config.telemetry.enabled = false
      config.telemetry.metrics = true

      appsec.enable(config)

      const metrics = appsecNamespace.metrics.toJSON()

      expect(metrics).to.be.undefined
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
    appsec.enable(new Config({
      appsec: {
        enabled: true,
        rasp: {
          enabled: false // disable rasp to not trigger lfi
        }
      }
    }))

    RuleManager.updateWafFromRC({ toUnapply: [], toApply: [], toModify })
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
        expect(res.status).to.be.equal(200)
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
          expect(res.status).to.be.equal(200)
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
          expect(err.response.status).to.be.equal(403)
          expect(err.response.data).to.deep.equal(jsonDefaultContent)
        })
      })

      it('should block the request with JSON content if accept */*', async () => {
        await axios.get(`http://localhost:${port}/`, {
          headers: {
            [ipHeader]: invalidIp,
            Accept: '*/*'
          }
        }).catch((err) => {
          expect(err.response.status).to.be.equal(403)
          expect(err.response.data).to.deep.equal(jsonDefaultContent)
        })
      })

      it('should block the request with html content if accept text/html', async () => {
        await axios.get(`http://localhost:${port}/`, {
          headers: {
            [ipHeader]: invalidIp,
            Accept: 'text/html'
          }
        }).catch((err) => {
          expect(err.response.status).to.be.equal(403)
          expect(err.response.data).to.be.equal(htmlDefaultContent)
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
        RuleManager.updateWafFromRC({
          toUnapply: [],
          toApply: [],
          toModify: [...toModify, ...toModifyCustomActions]
        })
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
          expect(err.message).to.not.equal('Not expected')
          expect(err.response.status).to.be.equal(500)
          expect(err.response.data).to.deep.equal(jsonDefaultContent)
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
          expect(err.message).to.not.equal('Not expected')
          expect(err.response.status).to.be.equal(500)
          expect(err.response.data).to.deep.equal(htmlDefaultContent)
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
        RuleManager.updateWafFromRC({
          toUnapply: [],
          toApply: [],
          toModify: [...toModify, ...toModifyCustomActions]
        })
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
          expect(err.message).to.not.equal('Not resolve expected')
          expect(err.response.status).to.be.equal(301)
          expect(err.response.headers.location).to.be.equal('/error')
        })
      })
    })
  })
})

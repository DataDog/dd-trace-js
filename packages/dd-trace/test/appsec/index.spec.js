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
  queryParser,
  passportVerify,
  responseBody
} = require('../../src/appsec/channels')
const Reporter = require('../../src/appsec/reporter')
const agent = require('../plugins/agent')
const Config = require('../../src/config')
const axios = require('axios')
const getPort = require('get-port')
const blockedTemplate = require('../../src/appsec/blocked_templates')
const { storage } = require('../../../datadog-core')
const telemetryMetrics = require('../../src/telemetry/metrics')
const addresses = require('../../src/appsec/addresses')

const resultActions = {
  block_request: {
    status_code: '401',
    type: 'auto',
    grpc_status_code: '10'
  }
}

describe('AppSec Index', () => {
  let config
  let AppSec
  let web
  let blocking
  let passport
  let log
  let appsecTelemetry
  let graphql
  let apiSecuritySampler
  let rasp

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
          enabled: true,
          mode: 'safe'
        },
        apiSecurity: {
          enabled: false,
          requestSampling: 0
        },
        rasp: {
          enabled: true
        }
      }
    }

    web = {
      root: sinon.stub()
    }

    blocking = {
      setTemplates: sinon.stub()
    }

    passport = {
      passportTrackEvent: sinon.stub()
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

    apiSecuritySampler = require('../../src/appsec/api_security_sampler')
    sinon.spy(apiSecuritySampler, 'sampleRequest')
    sinon.spy(apiSecuritySampler, 'isSampled')

    rasp = {
      enable: sinon.stub(),
      disable: sinon.stub()
    }

    AppSec = proxyquire('../../src/appsec', {
      '../log': log,
      '../plugins/util/web': web,
      './blocking': blocking,
      './passport': passport,
      './telemetry': appsecTelemetry,
      './graphql': graphql,
      './api_security_sampler': apiSecuritySampler,
      './rasp': rasp
    })

    sinon.stub(fs, 'readFileSync').returns(JSON.stringify(RULES))
    sinon.stub(waf, 'init').callThrough()
    sinon.stub(RuleManager, 'loadRules')
    sinon.stub(Reporter, 'setRateLimit')
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
      expect(Reporter.setRateLimit).to.have.been.calledOnceWithExactly(42)
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

      expect(log.error).to.have.been.calledTwice
      expect(log.error.firstCall).to.have.been.calledWithExactly('Unable to start AppSec')
      expect(log.error.secondCall).to.have.been.calledWithExactly(err)
      expect(incomingHttpRequestStart.subscribe).to.not.have.been.called
      expect(incomingHttpRequestEnd.subscribe).to.not.have.been.called
    })

    it('should subscribe to blockable channels', () => {
      expect(bodyParser.hasSubscribers).to.be.false
      expect(cookieParser.hasSubscribers).to.be.false
      expect(queryParser.hasSubscribers).to.be.false
      expect(passportVerify.hasSubscribers).to.be.false

      AppSec.enable(config)

      expect(bodyParser.hasSubscribers).to.be.true
      expect(cookieParser.hasSubscribers).to.be.true
      expect(queryParser.hasSubscribers).to.be.true
      expect(passportVerify.hasSubscribers).to.be.true
    })

    it('should not subscribe to passportVerify if eventTracking is disabled', () => {
      config.appsec.eventTracking.enabled = false

      AppSec.disable()
      AppSec.enable(config)

      expect(passportVerify.hasSubscribers).to.be.false
    })

    it('should call appsec telemetry enable', () => {
      config.telemetry = {
        enabled: true,
        metrics: true
      }
      AppSec.enable(config)

      expect(appsecTelemetry.enable).to.be.calledOnceWithExactly(config.telemetry)
    })

    it('should call rasp enable', () => {
      AppSec.enable(config)

      expect(rasp.enable).to.be.calledOnceWithExactly()
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
      expect(queryParser.hasSubscribers).to.be.false
      expect(passportVerify.hasSubscribers).to.be.false
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

    it('should propagate incoming http end data', () => {
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
          'content-lenght': 42
        }),
        statusCode: 201
      }

      web.patch(req)

      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          'server.response.status': '201',
          'server.response.headers.no_cookies': { 'content-type': 'application/json', 'content-lenght': 42 }
        }
      }, req)

      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res)
    })

    it('should propagate incoming http end data with invalid framework properties', () => {
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
          'content-lenght': 42
        }),
        statusCode: 201
      }

      web.patch(req)

      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          'server.response.status': '201',
          'server.response.headers.no_cookies': { 'content-type': 'application/json', 'content-lenght': 42 }
        }
      }, req)

      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res)
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
        params: {
          c: '3'
        },
        cookies: {
          d: '4',
          e: '5'
        }
      }
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-lenght': 42
        }),
        statusCode: 201
      }

      web.patch(req)

      sinon.stub(Reporter, 'finishRequest')
      AppSec.incomingHttpEndTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          'server.response.status': '201',
          'server.response.headers.no_cookies': { 'content-type': 'application/json', 'content-lenght': 42 },
          'server.request.body': { a: '1' },
          'server.request.path_params': { c: '3' },
          'server.request.cookies': { d: '4', e: '5' },
          'server.request.query': { b: '2' }
        }
      }, req)
      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res)
    })
  })

  describe('Api Security', () => {
    beforeEach(() => {
      sinon.stub(waf, 'run')

      const rootSpan = {
        addTags: sinon.stub()
      }

      web.root.returns(rootSpan)
    })

    it('should not trigger schema extraction with sampling disabled', () => {
      config.appsec.apiSecurity = {
        enabled: true,
        requestSampling: 0
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
        }
      }
      const res = {}

      AppSec.incomingHttpStartTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          'server.request.uri.raw': '/path',
          'server.request.headers.no_cookies': { 'user-agent': 'Arachni', host: 'localhost' },
          'server.request.method': 'POST',
          'http.client_ip': '127.0.0.1'
        }
      }, req)
    })

    it('should not trigger schema extraction with feature disabled', () => {
      config.appsec.apiSecurity = {
        enabled: false,
        requestSampling: 1
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
        }
      }
      const res = {}

      AppSec.incomingHttpStartTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          'server.request.uri.raw': '/path',
          'server.request.headers.no_cookies': { 'user-agent': 'Arachni', host: 'localhost' },
          'server.request.method': 'POST',
          'http.client_ip': '127.0.0.1'
        }
      }, req)
    })

    it('should trigger schema extraction with sampling enabled', () => {
      config.appsec.apiSecurity = {
        enabled: true,
        requestSampling: 1
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
        }
      }
      const res = {}

      AppSec.incomingHttpStartTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        persistent: {
          'server.request.uri.raw': '/path',
          'server.request.headers.no_cookies': { 'user-agent': 'Arachni', host: 'localhost' },
          'server.request.method': 'POST',
          'http.client_ip': '127.0.0.1',
          'waf.context.processor': { 'extract-schema': true }
        }
      }, req)
    })

    describe('onResponseBody', () => {
      beforeEach(() => {
        config.appsec.apiSecurity = {
          enabled: true,
          requestSampling: 1
        }
        AppSec.enable(config)
      })

      afterEach(() => {
        AppSec.disable()
      })

      it('should not do anything if body is not an object', () => {
        responseBody.publish({ req: {}, body: 'string' })
        responseBody.publish({ req: {}, body: null })

        expect(apiSecuritySampler.isSampled).to.not.been.called
        expect(waf.run).to.not.been.called
      })

      it('should not call to the waf if it is not a sampled request', () => {
        apiSecuritySampler.isSampled = apiSecuritySampler.isSampled.instantiateFake(() => false)
        const req = {}

        responseBody.publish({ req, body: {} })

        expect(apiSecuritySampler.isSampled).to.have.been.calledOnceWith(req)
        expect(waf.run).to.not.been.called
      })

      it('should call to the waf if it is a sampled request', () => {
        apiSecuritySampler.isSampled = apiSecuritySampler.isSampled.instantiateFake(() => true)
        const req = {}
        const body = {}

        responseBody.publish({ req, body })

        expect(apiSecuritySampler.isSampled).to.have.been.calledOnceWith(req)
        expect(waf.run).to.been.calledOnceWith({
          persistent: {
            [addresses.HTTP_OUTGOING_BODY]: body
          }
        }, req)
      })
    })
  })

  describe('Channel handlers', () => {
    let abortController, req, res, rootSpan

    beforeEach(() => {
      rootSpan = {
        addTags: sinon.stub()
      }
      web.root.returns(rootSpan)

      abortController = { abort: sinon.stub() }

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
        }
      }
      res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-lenght': 42
        }),
        writeHead: sinon.stub(),
        end: sinon.stub()
      }
      res.writeHead.returns(res)

      AppSec.enable(config)
      AppSec.incomingHttpStartTranslator({ req, res })
    })

    afterEach(() => {
      AppSec.disable()
    })

    describe('onRequestBodyParsed', () => {
      it('Should not block without body', () => {
        sinon.stub(waf, 'run')

        bodyParser.publish({ req, res, abortController })

        expect(waf.run).not.to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should not block with body by default', () => {
        const body = { key: 'value' }
        req.body = body
        sinon.stub(waf, 'run')

        bodyParser.publish({ req, res, body, abortController })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.body': { key: 'value' }
          }
        })
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should block when it is detected as attack', () => {
        const body = { key: 'value' }
        req.body = body
        sinon.stub(waf, 'run').returns(resultActions)

        bodyParser.publish({ req, res, body, abortController })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.body': { key: 'value' }
          }
        })
        expect(abortController.abort).to.have.been.called
        expect(res.end).to.have.been.called
      })
    })

    describe('onRequestCookieParsed', () => {
      it('Should not block without cookie', () => {
        sinon.stub(waf, 'run')

        cookieParser.publish({ req, res, abortController })

        expect(waf.run).not.to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should not block with cookie by default', () => {
        const cookies = { key: 'value' }
        sinon.stub(waf, 'run')

        cookieParser.publish({ req, res, abortController, cookies })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.cookies': { key: 'value' }
          }
        })
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should block when it is detected as attack', () => {
        const cookies = { key: 'value' }
        sinon.stub(waf, 'run').returns(resultActions)

        cookieParser.publish({ req, res, abortController, cookies })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.cookies': { key: 'value' }
          }
        })
        expect(abortController.abort).to.have.been.called
        expect(res.end).to.have.been.called
      })
    })

    describe('onRequestQueryParsed', () => {
      it('Should not block without query', () => {
        sinon.stub(waf, 'run')

        queryParser.publish({ req, res, abortController })

        expect(waf.run).not.to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should not block with query by default', () => {
        const query = { key: 'value' }
        req.query = query
        sinon.stub(waf, 'run')

        queryParser.publish({ req, res, query, abortController })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.query': { key: 'value' }
          }
        })
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should block when it is detected as attack', () => {
        const query = { key: 'value' }
        req.query = query
        sinon.stub(waf, 'run').returns(resultActions)

        queryParser.publish({ req, res, query, abortController })

        expect(waf.run).to.have.been.calledOnceWith({
          persistent: {
            'server.request.query': { key: 'value' }
          }
        })
        expect(abortController.abort).to.have.been.called
        expect(res.end).to.have.been.called
      })
    })

    describe('onPassportVerify', () => {
      it('Should call passportTrackEvent', () => {
        const credentials = { type: 'local', username: 'test' }
        const user = { id: '1234', username: 'Test' }

        sinon.stub(storage, 'getStore').returns({ req: {} })

        passportVerify.publish({ credentials, user })

        expect(passport.passportTrackEvent).to.have.been.calledOnceWithExactly(
          credentials,
          user,
          rootSpan,
          config.appsec.eventTracking.mode)
      })

      it('Should call log if no rootSpan is found', () => {
        const credentials = { type: 'local', username: 'test' }
        const user = { id: '1234', username: 'Test' }

        sinon.stub(storage, 'getStore').returns(undefined)

        passportVerify.publish({ credentials, user })

        expect(log.warn).to.have.been.calledOnceWithExactly('No rootSpan found in onPassportVerify')
        expect(passport.passportTrackEvent).not.to.have.been.called
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

      expect(metrics.series.length).to.equal(1)
      expect(metrics.series[0].metric).to.equal('waf.init')
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

describe('IP blocking', () => {
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
    file: ruleData
  }]
  const htmlDefaultContent = blockedTemplate.html
  const jsonDefaultContent = JSON.parse(blockedTemplate.json)

  let http, appListener, port
  before(() => {
    return getPort().then(newPort => {
      port = newPort
    })
  })
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
      .listen(port, 'localhost', () => done())
  })

  beforeEach(() => {
    appsec.enable(new Config({
      appsec: {
        enabled: true
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
          expect(err.response.status).to.be.equal(500)
          expect(err.response.data).to.deep.equal(htmlDefaultContent)
        })
      })
    })

    describe('Redirect on error', () => {
      const toModifyCustomActions = [{
        product: 'ASM',
        id: 'custom-actions',
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
          expect(err.response.status).to.be.equal(301)
          expect(err.response.headers.location).to.be.equal('/error')
        })
      })
    })
  })
})

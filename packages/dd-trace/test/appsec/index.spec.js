'use strict'

const dc = require('diagnostics_channel')
const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')

const log = require('../../src/log')
const RuleManager = require('../../src/appsec/rule_manager')
const remoteConfig = require('../../src/appsec/remote_config')
const appsec = require('../../src/appsec')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../src/appsec/gateway/channels')
const Gateway = require('../../src/appsec/gateway/engine')
const addresses = require('../../src/appsec/addresses')
const Reporter = require('../../src/appsec/reporter')
const agent = require('../plugins/agent')
const Config = require('../../src/config')
const axios = require('axios')
const getPort = require('get-port')
const { resetTemplates } = require('../../src/appsec/blocking')

describe('AppSec Index', () => {
  let config
  let AppSec
  let web

  beforeEach(() => {
    config = {
      appsec: {
        enabled: true,
        rules: './path/rules.json',
        rateLimit: 42,
        wafTimeout: 42,
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        blockedTemplateHtml: path.join(__dirname, '..', '..', 'src', 'appsec', 'templates', 'blocked.html'),
        blockedTemplateJson: path.join(__dirname, '..', '..', 'src', 'appsec', 'templates', 'blocked.json')
      }
    }

    web = {
      root: sinon.stub()
    }

    AppSec = proxyquire('../../src/appsec', {
      '../plugins/util/web': web
    })

    resetTemplates()

    sinon.stub(fs, 'readFileSync').returns('{"rules": [{"a": 1}]}')
    sinon.stub(fs.promises, 'readFile').returns('{"rules": [{"a": 1}]}')
    sinon.stub(RuleManager, 'applyRules')
    sinon.stub(remoteConfig, 'enableAsmData')
    sinon.stub(remoteConfig, 'disableAsmData')
    sinon.stub(Reporter, 'setRateLimit')
    sinon.stub(incomingHttpRequestStart, 'subscribe')
    sinon.stub(incomingHttpRequestEnd, 'subscribe')
    Gateway.manager.clear()
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('enable', () => {
    it('should enable AppSec only once', () => {
      AppSec.enable(config)
      AppSec.enable(config)

      expect(fs.readFileSync).to.have.been.calledWithExactly('./path/rules.json')
      expect(fs.readFileSync).to.have.been.calledWithExactly(config.appsec.blockedTemplateHtml)
      expect(fs.readFileSync).to.have.been.calledWithExactly(config.appsec.blockedTemplateJson)
      expect(RuleManager.applyRules).to.have.been.calledOnceWithExactly({ rules: [{ a: 1 }] }, config.appsec)
      expect(remoteConfig.enableAsmData).to.have.been.calledOnce
      expect(Reporter.setRateLimit).to.have.been.calledOnceWithExactly(42)
      expect(incomingHttpRequestStart.subscribe)
        .to.have.been.calledOnceWithExactly(AppSec.incomingHttpStartTranslator)
      expect(incomingHttpRequestEnd.subscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpEndTranslator)
      expect(Gateway.manager.addresses).to.have.all.keys(
        addresses.HTTP_INCOMING_HEADERS,
        addresses.HTTP_INCOMING_ENDPOINT,
        addresses.HTTP_INCOMING_RESPONSE_HEADERS,
        addresses.HTTP_INCOMING_REMOTE_IP
      )
    })

    it('should log when enable fails', () => {
      sinon.stub(log, 'error')
      RuleManager.applyRules.restore()

      const err = new Error('Invalid Rules')
      sinon.stub(RuleManager, 'applyRules').throws(err)

      AppSec.enable(config)

      expect(log.error).to.have.been.calledTwice
      expect(log.error.firstCall).to.have.been.calledWithExactly('Unable to start AppSec')
      expect(log.error.secondCall).to.have.been.calledWithExactly(err)
      expect(remoteConfig.disableAsmData).to.have.been.calledOnce
      expect(incomingHttpRequestStart.subscribe).to.not.have.been.called
      expect(incomingHttpRequestEnd.subscribe).to.not.have.been.called
      expect(Gateway.manager.addresses).to.be.empty
    })

    it('should subscribe to blockable channels', () => {
      const bodyParserChannel = dc.channel('datadog:body-parser:read:finish')
      const queryParserChannel = dc.channel('datadog:query:read:finish')

      expect(bodyParserChannel.hasSubscribers).to.be.false
      expect(queryParserChannel.hasSubscribers).to.be.false

      AppSec.enable(config)

      expect(bodyParserChannel.hasSubscribers).to.be.true
      expect(queryParserChannel.hasSubscribers).to.be.true
    })
  })

  describe('enableAsync', () => {
    it('should enable AppSec only once', async () => {
      await AppSec.enableAsync(config)
      await AppSec.enableAsync(config)

      expect(fs.readFileSync).not.to.have.been.called
      expect(fs.promises.readFile).to.have.been.calledThrice
      expect(fs.promises.readFile).to.have.been.calledWithExactly('./path/rules.json')
      expect(fs.promises.readFile).to.have.been.calledWithExactly(config.appsec.blockedTemplateHtml)
      expect(fs.promises.readFile).to.have.been.calledWithExactly(config.appsec.blockedTemplateJson)
      expect(RuleManager.applyRules).to.have.been.calledOnceWithExactly({ rules: [{ a: 1 }] }, config.appsec)
      expect(remoteConfig.enableAsmData).to.have.been.calledOnce
      expect(Reporter.setRateLimit).to.have.been.calledOnceWithExactly(42)
      expect(incomingHttpRequestStart.subscribe)
        .to.have.been.calledOnceWithExactly(AppSec.incomingHttpStartTranslator)
      expect(incomingHttpRequestEnd.subscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpEndTranslator)
      expect(Gateway.manager.addresses).to.have.all.keys(
        addresses.HTTP_INCOMING_HEADERS,
        addresses.HTTP_INCOMING_ENDPOINT,
        addresses.HTTP_INCOMING_RESPONSE_HEADERS,
        addresses.HTTP_INCOMING_REMOTE_IP
      )
    })

    it('should log when enable fails', async () => {
      sinon.stub(log, 'error')
      RuleManager.applyRules.restore()

      const err = new Error('Invalid Rules')
      sinon.stub(RuleManager, 'applyRules').throws(err)

      await AppSec.enableAsync(config)

      expect(log.error).to.have.been.calledTwice
      expect(log.error.firstCall).to.have.been.calledWithExactly('Unable to start AppSec')
      expect(log.error.secondCall).to.have.been.calledWithExactly(err)
      expect(remoteConfig.disableAsmData).to.have.been.calledOnce
      expect(incomingHttpRequestStart.subscribe).to.not.have.been.called
      expect(incomingHttpRequestEnd.subscribe).to.not.have.been.called
      expect(Gateway.manager.addresses).to.be.empty
    })

    it('should subscribe to blockable channels', async () => {
      const bodyParserChannel = dc.channel('datadog:body-parser:read:finish')
      const queryParserChannel = dc.channel('datadog:query:read:finish')

      expect(bodyParserChannel.hasSubscribers).to.be.false
      expect(queryParserChannel.hasSubscribers).to.be.false

      await AppSec.enableAsync(config)

      expect(bodyParserChannel.hasSubscribers).to.be.true
      expect(queryParserChannel.hasSubscribers).to.be.true
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
      expect(remoteConfig.disableAsmData).to.have.been.calledOnce
      expect(incomingHttpRequestStart.unsubscribe)
        .to.have.been.calledOnceWithExactly(AppSec.incomingHttpStartTranslator)
      expect(incomingHttpRequestEnd.unsubscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpEndTranslator)
    })

    it('should disable AppSec when DC channels are not active', () => {
      AppSec.enable(config)

      sinon.stub(RuleManager, 'clearAllRules')

      expect(AppSec.disable).to.not.throw()

      expect(RuleManager.clearAllRules).to.have.been.calledOnce
    })

    it('should unsubscribe to blockable channels', () => {
      const bodyParserChannel = dc.channel('datadog:body-parser:read:finish')
      const queryParserChannel = dc.channel('datadog:query:read:finish')

      AppSec.enable(config)

      AppSec.disable()

      expect(bodyParserChannel.hasSubscribers).to.be.false
      expect(queryParserChannel.hasSubscribers).to.be.false
    })
  })

  describe('incomingHttpStartTranslator', () => {
    beforeEach(() => {
      AppSec.enable(config)
    })

    it('should propagate incoming http start data', () => {
      const store = new Map()
      sinon.stub(Gateway, 'startContext').returns(store)
      const rootSpan = {
        addTags: sinon.stub()
      }

      web.root.returns(rootSpan)

      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          'host': 'localhost',
          cookie: 'a=1;b=2'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        }
      }
      const res = {}

      sinon.stub(Gateway, 'propagate')

      AppSec.incomingHttpStartTranslator({ req, res })

      expect(Gateway.startContext).to.have.been.calledOnce

      expect(store.get('req')).to.equal(req)
      expect(store.get('res')).to.equal(res)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        '_dd.appsec.enabled': 1,
        '_dd.runtime_family': 'nodejs',
        'http.client_ip': '127.0.0.1'
      })
      expect(Gateway.propagate).to.have.been.calledOnceWith({
        'server.request.uri.raw': '/path',
        'server.request.headers.no_cookies': { 'user-agent': 'Arachni', host: 'localhost' },
        'server.request.method': 'POST',
        'server.request.client_ip': '127.0.0.1',
        'server.request.client_port': 8080,
        'http.client_ip': '127.0.0.1'
      })
    })
  })

  describe('incomingHttpEndTranslator', () => {
    beforeEach(() => {
      AppSec.enable(config)
      const rootSpan = {
        addTags: sinon.stub()
      }
      web.root.returns(rootSpan)
    })

    it('should do nothing when context is not found', () => {
      const req = {}
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-lenght': 42
        }),
        statusCode: 201
      }

      sinon.stub(Gateway, 'propagate')
      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(Gateway.propagate).to.not.have.been.called
      expect(Reporter.finishRequest).to.not.have.been.called
    })

    it('should propagate incoming http end data', () => {
      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          'host': 'localhost',
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

      AppSec.incomingHttpStartTranslator({ req, res })
      sinon.stub(Gateway, 'propagate')
      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(Gateway.propagate).to.have.been.calledOnceWith({
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        }
      })
      expect(Reporter.finishRequest).to.have.been.calledOnceWith(req)
    })

    it('should propagate incoming http end data with invalid framework properties', () => {
      const context = {
        dispatch: sinon.stub(),
        setValue: sinon.stub()
      }
      const store = new Map()
      store.set('context', context)
      sinon.stub(Gateway, 'startContext').returns(store)
      sinon.stub(Gateway, 'getContext').returns(context)

      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          'host': 'localhost',
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

      AppSec.incomingHttpStartTranslator({ req, res })
      sinon.stub(Gateway, 'propagate')
      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(Gateway.startContext).to.have.been.calledOnce
      expect(store.get('req')).to.equal(req)
      expect(store.get('res')).to.equal(res)
      expect(Gateway.propagate).to.have.been.calledOnceWithExactly({
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        }
      }, context)
      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, context)
    })

    it('should propagate incoming http end data with express', () => {
      const context = {
        dispatch: sinon.stub(),
        setValue: sinon.stub()

      }
      const store = new Map()
      store.set('context', context)
      sinon.stub(Gateway, 'startContext').returns(store)
      sinon.stub(Gateway, 'getContext').returns(context)

      const req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          'host': 'localhost',
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
      AppSec.incomingHttpStartTranslator({ req, res })
      sinon.stub(Gateway, 'propagate')
      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(Gateway.startContext).to.have.been.calledOnce
      expect(store.get('req')).to.equal(req)
      expect(store.get('res')).to.equal(res)
      expect(Gateway.propagate).to.have.been.calledOnceWithExactly({
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        },
        'server.request.query': { b: '2' },
        'server.request.framework_endpoint': '/path/:c',
        'server.request.path_params': { c: '3' }
      }, context)
      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, context)
    })
  })

  describe('checkRequestData', () => {
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
          'host': 'localhost'
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
        setHeader: sinon.stub(),
        end: sinon.stub()
      }

      AppSec.enable(config)
      AppSec.incomingHttpStartTranslator({ req, res })
    })

    afterEach(() => {
      AppSec.disable()
    })

    describe('onRequestBodyParsed', () => {
      const bodyParserChannel = dc.channel('datadog:body-parser:read:finish')

      it('Should not block without body', () => {
        sinon.stub(Gateway, 'propagate')

        bodyParserChannel.publish({
          req, res, abortController
        })

        expect(Gateway.propagate).not.to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should not block with body by default', () => {
        req.body = { key: 'value' }
        sinon.stub(Gateway, 'propagate')

        bodyParserChannel.publish({
          req, res, abortController
        })

        expect(Gateway.propagate).to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should block when it is detected as attack', () => {
        req.body = { key: 'value' }
        sinon.stub(Gateway, 'propagate').returns(['block'])

        bodyParserChannel.publish({
          req, res, abortController
        })

        expect(abortController.abort).to.have.been.called
        expect(res.end).to.have.been.called
      })

      it('Should propagate request body', () => {
        req.body = { key: 'value' }
        sinon.stub(Gateway, 'propagate')

        bodyParserChannel.publish({
          req, res, abortController
        })

        expect(Gateway.propagate).to.have.been.calledOnceWith({
          'server.request.body': { key: 'value' }
        })
      })
    })

    describe('onRequestQueryParsed', () => {
      const queryParserReadChannel = dc.channel('datadog:query:read:finish')

      it('Should not block without query', () => {
        sinon.stub(Gateway, 'propagate')

        queryParserReadChannel.publish({
          req, res, abortController
        })

        expect(Gateway.propagate).not.to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should not block with query by default', () => {
        req.query = { key: 'value' }
        sinon.stub(Gateway, 'propagate')

        queryParserReadChannel.publish({
          req, res, abortController
        })

        expect(Gateway.propagate).to.have.been.called
        expect(abortController.abort).not.to.have.been.called
        expect(res.end).not.to.have.been.called
      })

      it('Should block when it is detected as attack', () => {
        req.query = { key: 'value' }
        sinon.stub(Gateway, 'propagate').returns(['block'])

        queryParserReadChannel.publish({
          req, res, abortController
        })

        expect(abortController.abort).to.have.been.called
        expect(res.end).to.have.been.called
      })

      it('Should propagate request query', () => {
        req.query = { key: 'value' }
        sinon.stub(Gateway, 'propagate')

        queryParserReadChannel.publish({
          req, res, abortController
        })

        expect(Gateway.propagate).to.have.been.calledOnceWith({
          'server.request.query': { key: 'value' }
        })
      })
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
    RuleManager.updateAsmData('apply', ruleData, 'asm_data')
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
      const templatesPath = path.join(__dirname, '..', '..', 'src', 'appsec', 'templates')
      const htmlDefaultContent = fs.readFileSync(path.join(templatesPath, 'blocked.html'), 'utf8').toString()
      const jsonDefaultContent = JSON.parse(
        fs.readFileSync(path.join(templatesPath, 'blocked.json'), 'utf8').toString()
      )

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
            'Accept': '*/*'
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
            'Accept': 'text/html'
          }
        }).catch((err) => {
          expect(err.response.status).to.be.equal(403)
          expect(err.response.data).to.be.equal(htmlDefaultContent)
        })
      })
    })
  })
})

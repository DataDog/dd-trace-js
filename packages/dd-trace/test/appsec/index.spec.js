'use strict'

const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')
const log = require('../../src/log')
const waf = require('../../src/appsec/waf')
const WAFManager = require('../../src/appsec/waf/waf_manager')
const WAFContextWrapper = require('../../src/appsec/waf/waf_context_wrapper')
const RuleManager = require('../../src/appsec/rule_manager')
const remoteConfig = require('../../src/appsec/remote_config')
const appsec = require('../../src/appsec')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../src/appsec/channels')
const Reporter = require('../../src/appsec/reporter')
const agent = require('../plugins/agent')
const Config = require('../../src/config')
const axios = require('axios')
const getPort = require('get-port')
const web = require('../../src/plugins/util/web')
const { resetTemplates } = require('../../src/appsec/blocking')

describe('AppSec Index', () => {
  let config
  let AppSec

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
    sinon.stub(web, 'root')
    sinon.stub(web, 'getContext').returns({})

    AppSec = proxyquire('../../src/appsec', {
      '../plugins/util/web': web
    })

    resetTemplates()

    const readFileSyncStub = sinon.stub(fs, 'readFileSync')
    readFileSyncStub.withArgs('./path/rules.json').returns('{"rules": [{"a": 1}]}')
    readFileSyncStub.callThrough()
    const readFilePromiseStub = sinon.stub(fs.promises, 'readFile')
    readFilePromiseStub.withArgs('./path/rules.json').returns('{"rules": [{"a": 1}]}')
    readFilePromiseStub.callThrough()
    sinon.stub(waf, 'init').callThrough()
    sinon.stub(WAFManager.prototype, 'createDDWAFContext').callThrough()
    sinon.stub(WAFContextWrapper.prototype, 'run')
    sinon.stub(RuleManager, 'applyRules')
    sinon.stub(remoteConfig, 'enableAsmData')
    sinon.stub(remoteConfig, 'enableAsmDDRules')
    sinon.stub(remoteConfig, 'disableAsmData')
    sinon.stub(remoteConfig, 'disableAsmDDRules')
    sinon.stub(Reporter, 'setRateLimit')
    sinon.stub(incomingHttpRequestStart, 'subscribe')
    sinon.stub(incomingHttpRequestEnd, 'subscribe')
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
      expect(remoteConfig.enableAsmDDRules).to.have.been.calledOnce
      expect(Reporter.setRateLimit).to.have.been.calledOnceWithExactly(42)
      expect(incomingHttpRequestStart.subscribe)
        .to.have.been.calledOnceWithExactly(AppSec.incomingHttpStartTranslator)
      expect(incomingHttpRequestEnd.subscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpEndTranslator)
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
      expect(remoteConfig.disableAsmDDRules).to.have.been.calledOnce
      expect(incomingHttpRequestStart.subscribe).to.not.have.been.called
      expect(incomingHttpRequestEnd.subscribe).to.not.have.been.called
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
      expect(remoteConfig.enableAsmDDRules).to.have.been.calledOnce
      expect(Reporter.setRateLimit).to.have.been.calledOnceWithExactly(42)
      expect(incomingHttpRequestStart.subscribe)
        .to.have.been.calledOnceWithExactly(AppSec.incomingHttpStartTranslator)
      expect(incomingHttpRequestEnd.subscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpEndTranslator)
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
      expect(remoteConfig.disableAsmDDRules).to.have.been.calledOnce
      expect(incomingHttpRequestStart.subscribe).to.not.have.been.called
      expect(incomingHttpRequestEnd.subscribe).to.not.have.been.called
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
      expect(remoteConfig.disableAsmDDRules).to.have.been.calledOnce
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
  })

  describe('incomingHttpStartTranslator', () => {
    beforeEach(() => {
      AppSec.enable(config)
      waf.init(require('../../src/appsec/recommended.json'), config.appsec)
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

      AppSec.incomingHttpStartTranslator({ req, res })

      expect(WAFManager.prototype.createDDWAFContext).to.have.been.calledOnceWithExactly(req)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        '_dd.appsec.enabled': 1,
        '_dd.runtime_family': 'nodejs',
        'http.client_ip': '127.0.0.1'
      })
      expect(WAFContextWrapper.prototype.run).to.have.been.calledOnceWith({
        'http.client_ip': '127.0.0.1'
      })
    })
  })

  describe('incomingHttpEndTranslator', () => {
    beforeEach(() => {
      AppSec.enable(config)

      waf.init(require('../../src/appsec/recommended.json'), config.appsec)

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

      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(WAFContextWrapper.prototype.run).to.not.have.been.called
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

      web.patch(req)

      AppSec.incomingHttpStartTranslator({ req, res })
      sinon.stub(Reporter, 'finishRequest')
      WAFContextWrapper.prototype.run.resetHistory()

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(WAFContextWrapper.prototype.run).to.have.been.calledOnceWithExactly({
        'server.request.uri.raw': '/path',
        'server.request.headers.no_cookies': {
          'user-agent': 'Arachni',
          'host': 'localhost'
        },
        'server.request.method': 'POST',
        'server.request.client_ip': '127.0.0.1',
        'server.request.client_port': 8080,
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        }
      })
      expect(Reporter.finishRequest).to.have.been.calledOnceWith(req)
    })

    it('should propagate incoming http end data with invalid framework properties', () => {
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

      web.patch(req)

      AppSec.incomingHttpStartTranslator({ req, res })
      sinon.stub(Reporter, 'finishRequest')
      WAFContextWrapper.prototype.run.resetHistory()

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(WAFManager.prototype.createDDWAFContext).to.have.been.calledOnceWithExactly(req)
      const expectedPayload = {
        'server.request.uri.raw': '/path',
        'server.request.headers.no_cookies': {
          'user-agent': 'Arachni',
          'host': 'localhost'
        },
        'server.request.method': 'POST',
        'server.request.client_ip': '127.0.0.1',
        'server.request.client_port': 8080,
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        }
      }
      expect(WAFContextWrapper.prototype.run).to.have.been.calledOnceWithExactly(expectedPayload)
      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req,
        waf.wafManager.getDDWAFContext(req), expectedPayload)
    })

    it('should propagate incoming http end data with express', () => {
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

      web.patch(req)

      AppSec.incomingHttpStartTranslator({ req, res })
      WAFContextWrapper.prototype.run.resetHistory()
      sinon.stub(Reporter, 'finishRequest')
      const ddwafContext = waf.wafManager.getDDWAFContext(req)
      AppSec.incomingHttpEndTranslator({ req, res })

      const expectedPayload = {
        'server.request.uri.raw': '/path',
        'server.request.headers.no_cookies': {
          'user-agent': 'Arachni',
          'host': 'localhost'
        },
        'server.request.method': 'POST',
        'server.request.client_ip': '127.0.0.1',
        'server.request.client_port': 8080,
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        },
        'server.request.body': { a: '1' },
        'server.request.query': { b: '2' },
        'server.request.framework_endpoint': '/path/:c',
        'server.request.path_params': { c: '3' },
        'server.request.cookies': { d: [ '4' ], e: [ '5' ] }
      }
      expect(WAFContextWrapper.prototype.run).to.have.been.calledOnceWithExactly(expectedPayload)
      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, ddwafContext, expectedPayload)
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
    resetTemplates()
  })

  describe('do not block the request', () => {
    it('should not block the request by default', async () => {
      await axios.get(`http://localhost:${port}/`).then((res) => {
        expect(res.status).to.be.equal(200)
      })
    })
  })

  after(() => {
    appListener && appListener.close()
    return agent.close({ ritmReset: false })
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

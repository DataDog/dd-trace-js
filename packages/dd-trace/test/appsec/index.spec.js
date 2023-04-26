'use strict'

const proxyquire = require('proxyquire')
const log = require('../../src/log')
const waf = require('../../src/appsec/waf')
const RuleManager = require('../../src/appsec/rule_manager')
const appsec = require('../../src/appsec')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../src/appsec/channels')
const Reporter = require('../../src/appsec/reporter')
const agent = require('../plugins/agent')
const Config = require('../../src/config')
const axios = require('axios')
const getPort = require('get-port')
const blockedTemplate = require('../../src/appsec/blocked_templates')

describe('AppSec Index', () => {
  let config
  let AppSec
  let web
  let blocking

  const RULES = { rules: [{ a: 1 }] }

  beforeEach(() => {
    config = {
      appsec: {
        enabled: true,
        rules: RULES,
        rateLimit: 42,
        wafTimeout: 42,
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        blockedTemplateHtml: blockedTemplate.html,
        blockedTemplateJson: blockedTemplate.json
      }
    }

    web = {
      root: sinon.stub()
    }

    blocking = {
      setTemplates: sinon.stub()
    }

    AppSec = proxyquire('../../src/appsec', {
      '../plugins/util/web': web,
      './blocking': blocking
    })

    sinon.stub(waf, 'init').callThrough()
    sinon.stub(RuleManager, 'applyRules')
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

      expect(blocking.setTemplates).to.have.been.calledOnceWithExactly(config)
      expect(RuleManager.applyRules).to.have.been.calledOnceWithExactly(RULES, config.appsec)
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

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({
        '_dd.appsec.enabled': 1,
        '_dd.runtime_family': 'nodejs',
        'http.client_ip': '127.0.0.1'
      })
      expect(waf.run).to.have.been.calledOnceWith({
        'http.client_ip': '127.0.0.1'
      })
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

      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        'server.request.uri.raw': '/path',
        'server.request.headers.no_cookies': {
          'user-agent': 'Arachni',
          'host': 'localhost'
        },
        'server.request.method': 'POST',
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        }
      }, req)
      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res)
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

      sinon.stub(Reporter, 'finishRequest')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        'server.request.uri.raw': '/path',
        'server.request.headers.no_cookies': {
          'user-agent': 'Arachni',
          'host': 'localhost'
        },
        'server.request.method': 'POST',
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        }
      }, req)

      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res)
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

      sinon.stub(Reporter, 'finishRequest')
      AppSec.incomingHttpEndTranslator({ req, res })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        'server.request.uri.raw': '/path',
        'server.request.headers.no_cookies': {
          'user-agent': 'Arachni',
          'host': 'localhost'
        },
        'server.request.method': 'POST',
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        },
        'server.request.body': { a: '1' },
        'server.request.query': { b: '2' },
        'server.request.path_params': { c: '3' },
        'server.request.cookies': { d: ['4'], e: ['5'] }
      }, req)
      expect(Reporter.finishRequest).to.have.been.calledOnceWithExactly(req, res)
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
      const htmlDefaultContent = blockedTemplate.html
      const jsonDefaultContent = JSON.parse(blockedTemplate.json)

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

'use strict'

const fs = require('fs')
const path = require('path')
const log = require('../../src/log')
const AppSec = require('../../src/appsec')
const RuleManager = require('../../src/appsec/rule_manager')
const { INCOMING_HTTP_REQUEST_START } = require('../../src/gateway/channels')
const Gateway = require('../../src/gateway/engine/index')
const Addresses = require('../../src/appsec/addresses')

describe('AppSec Index', () => {
  let config

  beforeEach(() => {
    config = { tags: {} }
    global._ddtrace = { _tracer: { _tags: config.tags } }

    sinon.stub(fs, 'readFileSync').returns('{"rules": [{"a": 1}]}')
    sinon.stub(RuleManager, 'applyRules')
    sinon.stub(INCOMING_HTTP_REQUEST_START, 'subscribe')
    Gateway.manager.clear()
  })

  afterEach(() => {
    sinon.restore()
    AppSec.disable()
  })

  describe('enable', () => {
    it('should enable AppSec', () => {
      AppSec.enable(config)

      const rulesPath = path.resolve(path.join(__dirname, '..', '..', 'src', 'appsec', 'recommended.json'))
      expect(fs.readFileSync).to.have.been.calledOnceWithExactly(rulesPath)
      expect(RuleManager.applyRules).to.have.been.calledOnceWithExactly({ rules: [{ a: 1 }] })
      expect(INCOMING_HTTP_REQUEST_START.subscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpTranslator)
      expect(config.tags).to.deep.equal({
        '_dd.appsec.enabled': 1,
        '_dd.runtime_family': 'nodejs'
      })
      expect(Gateway.manager.addresses).to.have.all.keys(
        Addresses.HTTP_INCOMING_URL,
        Addresses.HTTP_INCOMING_HEADERS,
        Addresses.HTTP_INCOMING_METHOD,
        Addresses.HTTP_INCOMING_REMOTE_IP,
        Addresses.HTTP_INCOMING_REMOTE_PORT
      )
    })

    it('should log when enable fails', () => {
      sinon.stub(log, 'error')
      RuleManager.applyRules.restore()
      sinon.stub(RuleManager, 'applyRules').throws(new Error('Invalid Rules'))

      AppSec.enable(config)

      expect(log.error).to.have.been.calledOnceWithExactly('Unable to apply AppSec rules: Error: Invalid Rules')
    })
  })

  describe('disable', () => {
    it('should disable AppSec', () => {
      // we need real DC for this test
      INCOMING_HTTP_REQUEST_START.subscribe.restore()

      AppSec.enable(config)

      sinon.stub(RuleManager, 'clearAllRules')
      sinon.spy(INCOMING_HTTP_REQUEST_START, 'unsubscribe')

      AppSec.disable()

      expect(RuleManager.clearAllRules).to.have.been.calledOnce
      expect(INCOMING_HTTP_REQUEST_START.unsubscribe).to.have.been.calledOnceWithExactly(AppSec.incomingHttpTranslator)
      expect(config.tags).to.not.have.any.keys('_dd.appsec.enabled', '_dd.runtime_family')
    })

    it('should disable AppSec when DC channels are not active', () => {
      AppSec.enable(config)

      sinon.stub(RuleManager, 'clearAllRules')

      expect(AppSec.disable).to.not.throw()

      expect(RuleManager.clearAllRules).to.have.been.calledOnce
      expect(config.tags).to.not.have.any.keys('_dd.appsec.enabled', '_dd.runtime_family')
    })
  })

  describe('incomingHttpTranslator', () => {
    it('should propagate incoming http data', () => {
      const store = new Map()
      sinon.stub(Gateway, 'startContext').returns(store)

      const context = {}
      store.set('context', context)

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

      AppSec.incomingHttpTranslator({ req, res })

      expect(Gateway.startContext).to.have.been.calledOnce
      expect(store.get('req')).to.equal(req)
      expect(store.get('res')).to.equal(res)
      expect(Gateway.propagate).to.have.been.calledOnceWithExactly({
        'server.request.uri.raw': '/path',
        'server.request.headers.no_cookies': {
          'user-agent': 'Arachni',
          'host': 'localhost'
        },
        'server.request.method': 'POST',
        'server.request.remote_ip': '127.0.0.1',
        'server.request.remote_port': 8080
      }, context)
    })
  })
})

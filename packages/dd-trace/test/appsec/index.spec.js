'use strict'

const fs = require('fs')
const log = require('../../src/log')
const AppSec = require('../../src/appsec')
const RuleManager = require('../../src/appsec/rule_manager')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../src/appsec/gateway/channels')
const Gateway = require('../../src/appsec/gateway/engine')
const addresses = require('../../src/appsec/addresses')
const Reporter = require('../../src/appsec/reporter')

describe('AppSec Index', () => {
  let config

  beforeEach(() => {
    config = {
      appsec: {
        enabled: true,
        rules: './path/rules.json'
      }
    }

    sinon.stub(fs, 'readFileSync').returns('{"rules": [{"a": 1}]}')
    sinon.stub(RuleManager, 'applyRules')
    sinon.stub(incomingHttpRequestStart, 'subscribe')
    sinon.stub(incomingHttpRequestEnd, 'subscribe')
    Gateway.manager.clear()
  })

  afterEach(() => {
    sinon.restore()
    AppSec.disable()
  })

  describe('enable', () => {
    it('should enable AppSec', () => {
      AppSec.enable(config)

      expect(fs.readFileSync).to.have.been.calledOnceWithExactly('./path/rules.json')
      expect(RuleManager.applyRules).to.have.been.calledOnceWithExactly({ rules: [{ a: 1 }] })
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
      expect(incomingHttpRequestStart.subscribe).to.not.have.been.called
      expect(incomingHttpRequestEnd.subscribe).to.not.have.been.called
      expect(Gateway.manager.addresses).to.be.empty
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
    it('should propagate incoming http start data', () => {
      const store = new Map()
      sinon.stub(Gateway, 'startContext').returns(store)

      const context = {}
      store.set('context', context)

      const topSpan = {
        addTags: sinon.stub()
      }

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
        _datadog: {
          span: topSpan
        }
      }
      const res = {}

      sinon.stub(Gateway, 'propagate')

      AppSec.incomingHttpStartTranslator({ req, res })

      expect(topSpan.addTags).to.have.been.calledOnceWithExactly({
        '_dd.appsec.enabled': 1,
        '_dd.runtime_family': 'nodejs'
      })
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
        'server.request.client_ip': '127.0.0.1',
        'server.request.client_port': 8080
      }, context)
    })
  })

  describe('incomingHttpEndTranslator', () => {
    it('should do nothing when context is not found', () => {
      sinon.stub(Gateway, 'getContext').returns(null)

      const req = {}
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-lenght': 42
        }),
        statusCode: 201
      }

      sinon.stub(Gateway, 'propagate')
      sinon.stub(Reporter, 'finishAttacks')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(Gateway.getContext).to.have.been.calledOnce
      expect(Gateway.propagate).to.not.have.been.called
      expect(Reporter.finishAttacks).to.not.have.been.called
    })

    it('should propagate incoming http end data', () => {
      const context = {}

      sinon.stub(Gateway, 'getContext').returns(context)

      const req = {}
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-lenght': 42
        }),
        statusCode: 201
      }

      sinon.stub(Gateway, 'propagate')
      sinon.stub(Reporter, 'finishAttacks')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(Gateway.getContext).to.have.been.calledOnce
      expect(Gateway.propagate).to.have.been.calledOnceWithExactly({
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        }
      }, context)
      expect(Reporter.finishAttacks).to.have.been.calledOnceWithExactly(req, context)
    })

    it('should propagate incoming http end data with weird framework', () => {
      const context = {}

      sinon.stub(Gateway, 'getContext').returns(context)

      const req = {
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

      sinon.stub(Gateway, 'propagate')
      sinon.stub(Reporter, 'finishAttacks')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(Gateway.getContext).to.have.been.calledOnce
      expect(Gateway.propagate).to.have.been.calledOnceWithExactly({
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        }
      }, context)
      expect(Reporter.finishAttacks).to.have.been.calledOnceWithExactly(req, context)
    })

    it('should propagate incoming http end data with express', () => {
      const context = {}

      sinon.stub(Gateway, 'getContext').returns(context)

      const req = {
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
          d: '4'
        }
      }
      const res = {
        getHeaders: () => ({
          'content-type': 'application/json',
          'content-lenght': 42
        }),
        statusCode: 201
      }

      sinon.stub(Gateway, 'propagate')
      sinon.stub(Reporter, 'finishAttacks')

      AppSec.incomingHttpEndTranslator({ req, res })

      expect(Gateway.getContext).to.have.been.calledOnce
      expect(Gateway.propagate).to.have.been.calledOnceWithExactly({
        'server.response.status': 201,
        'server.response.headers.no_cookies': {
          'content-type': 'application/json',
          'content-lenght': 42
        },
        // 'server.request.body': { a: '1' },
        'server.request.query': { b: '2' },
        'server.request.framework_endpoint': '/path/:c',
        'server.request.path_params': { c: '3' },
        'server.request.cookies': { d: '4' }
      }, context)
      expect(Reporter.finishAttacks).to.have.been.calledOnceWithExactly(req, context)
    })
  })
})

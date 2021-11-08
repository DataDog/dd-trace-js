'use strict'

const WAFCallback = require('../../../src/appsec/callbacks/ddwaf')
const Gateway = require('../../../src/gateway/engine')
const Reporter = require('../../../src/appsec/reporter')
const rules = require('../../../src/appsec/recommended.json')
const log = require('../../../src/log')

const DEFAULT_MAX_BUDGET = 5e3

describe('WAFCallback', () => {
  afterEach(() => {
    sinon.restore()
  })

  describe('loadDDWAF', () => {
    it('should instanciate DDWAF', () => {
      const result = WAFCallback.loadDDWAF(rules)

      expect(result).itself.to.respondTo('createContext')
      expect(result).itself.to.respondTo('dispose')
    })

    it('should log exceptions only once', () => {
      sinon.spy(log, 'warn')

      const wafError = () => WAFCallback.loadDDWAF({})

      expect(wafError).to.throw('Invalid rules')
      expect(wafError).to.throw('Invalid rules')

      expect(log.warn).to.have.been
        .calledOnceWithExactly('AppSec could not load native package. In-app WAF features will not be available.')
    })
  })

  describe('constructor', () => {
    it('should parse rules', () => {
      const rules = {
        rules: [{
          conditions: [{
            parameters: {
              inputs: [{
                address: 'server.request.headers.no_cookies:user-agent'
              }, {
                address: 'server.request.uri.raw'
              }, {
                address: 'server.request.headers.no_cookies'
              }]
            }
          }, {
            parameters: {
              inputs: [{
                address: 'server.request.headers.no_cookies'
              }, {
                address: 'server.request.headers.no_cookies:user-agent'
              }, {
                address: 'server.request.uri.raw'
              }]
            }
          }]
        }, {
          id: 'ruleId',
          conditions: [{
            parameters: {
              inputs: [{
                address: 'server.request.remote_ip'
              }]
            }
          }, {
            parameters: {
              inputs: [{
                address: 'invalid_address'
              }, {
                address: 'server.request.remote_port'
              }]
            }
          }]
        }, {
          conditions: [{
            parameters: {
              inputs: [{
                address: 'server.request.uri.raw'
              }, {
                address: 'server.request.headers.no_cookies'
              }, {
                address: 'server.request.headers.no_cookies:user-agent'
              }]
            }
          }, {
            parameters: {
              inputs: [{
                address: 'server.request.uri.raw'
              }, {
                address: 'server.request.headers.no_cookies'
              }, {
                address: 'server.request.headers.no_cookies:user-agent'
              }, {
                address: 'server.request.method'
              }]
            }
          }]
        }]
      }

      const ddwaf = {}

      sinon.stub(WAFCallback, 'loadDDWAF').returns(ddwaf)

      sinon.stub(WAFCallback.prototype, 'action')

      sinon.spy(log, 'warn')

      sinon.stub(Gateway.manager, 'addSubscription')

      const waf = new WAFCallback(rules)

      expect(WAFCallback.loadDDWAF).to.have.been.calledOnceWithExactly(rules)
      expect(waf.ddwaf).to.equal(ddwaf)
      expect(waf.wafContextCache).to.be.an.instanceOf(WeakMap)

      expect(log.warn).to.have.been.calledOnceWithExactly('Skipping invalid rule ruleId')

      expect(Gateway.manager.addSubscription).to.have.been.calledTwice

      const firstCall = Gateway.manager.addSubscription.firstCall.firstArg
      expect(firstCall).to.have.property('addresses').that.is.an('array').that.deep.equals([
        'server.request.headers.no_cookies',
        'server.request.uri.raw'
      ])
      expect(firstCall).to.have.nested.property('callback.method').that.is.a('function')
      const callback = firstCall.callback

      const secondCall = Gateway.manager.addSubscription.secondCall.firstArg
      expect(secondCall).to.have.property('addresses').that.is.an('array').that.deep.equals([
        'server.request.headers.no_cookies',
        'server.request.method',
        'server.request.uri.raw'
      ])
      expect(secondCall).to.have.property('callback').that.equals(callback)

      callback.method('params', 'store')
      expect(WAFCallback.prototype.action).to.have.been.calledOnceWithExactly('params', 'store')
      expect(WAFCallback.prototype.action).to.have.been.calledOn(waf)
    })
  })

  describe('methods', () => {
    let waf

    beforeEach(() => {
      sinon.stub(WAFCallback, 'loadDDWAF').returns({
        createContext: sinon.spy(() => ({
          run: sinon.stub().returns({ action: 'monitor', data: '[]' })
        })),
        dispose: sinon.stub()
      })

      waf = new WAFCallback(rules)
    })

    describe('action', () => {
      let store

      beforeEach(() => {
        store = new Map()

        store.set('context', {})

        sinon.stub(waf, 'applyResult')
      })

      it('should get wafContext from cache', () => {
        const wafContext = waf.ddwaf.createContext()

        waf.wafContextCache.set(store.get('context'), wafContext)

        waf.action({ a: 1, b: 2 }, store)

        expect(wafContext.run).to.have.been.calledOnceWithExactly({ a: 1, b: 2 }, DEFAULT_MAX_BUDGET)
        expect(waf.applyResult).to.have.been.calledOnceWithExactly({ action: 'monitor', data: '[]' })
      })

      it('should create wafContext and cache it', () => {
        waf.action({ a: 1, b: 2 }, store)

        expect(waf.ddwaf.createContext).to.have.been.calledOnce

        const key = store.get('context')
        const wafContext = waf.wafContextCache.get(key)

        expect(wafContext.run).to.have.been.calledOnceWithExactly({ a: 1, b: 2 }, DEFAULT_MAX_BUDGET)
        expect(waf.applyResult).to.have.been.calledOnceWithExactly({ action: 'monitor', data: '[]' })
      })

      it('should create wafContext and not cache it when no request context is found', () => {
        sinon.spy(waf.wafContextCache, 'set')

        waf.action({ a: 1, b: 2 }, new Map())

        expect(waf.ddwaf.createContext).to.have.been.calledOnce
        expect(waf.wafContextCache.set).to.not.have.been.called
        expect(waf.applyResult).to.have.been.calledOnceWithExactly({ action: 'monitor', data: '[]' })
      })

      it('should create wafContext and not cache it when no store is passed', () => {
        sinon.spy(waf.wafContextCache, 'set')

        waf.action({ a: 1, b: 2 })

        expect(waf.ddwaf.createContext).to.have.been.calledOnce
        expect(waf.wafContextCache.set).to.not.have.been.called
        expect(waf.applyResult).to.have.been.calledOnceWithExactly({ action: 'monitor', data: '[]' })
      })

      it('should catch and log exceptions', () => {
        sinon.spy(log, 'warn')

        const wafContext = {
          run: sinon.stub().throws(new Error('Empty params'))
        }

        waf.wafContextCache.set(store.get('context'), wafContext)

        expect(() => waf.action({ a: 1, b: 2 }, store)).to.not.throw()
        expect(wafContext.run).to.have.been.calledOnceWithExactly({ a: 1, b: 2 }, DEFAULT_MAX_BUDGET)
        expect(waf.applyResult).to.not.have.been.called
        expect(log.warn).to.have.been.calledOnceWithExactly('Error while running the AppSec WAF')
      })
    })

    describe('applyResult', () => {
      beforeEach(() => {
        sinon.stub(Reporter, 'reportAttack')
      })

      it('should call reporter with parsed attacks when passed action', () => {
        waf.applyResult({
          action: 'monitor',
          data: JSON.stringify([{
            rule: {
              id: 'ruleId',
              name: 'ruleName',
              tags: {
                type: 'ruleType',
                category: 'ruleCategory'
              }
            },
            rule_matches: [{
              operator: 'matchOperator',
              operator_value: 'matchOperatorValue',
              parameters: [{
                address: 'headers',
                key_path: ['user-agent', 0],
                value: 'arachni/v1',
                highlight: ['arachni/v']
              }, {
                address: 'url',
                key_path: [],
                value: '/wordpress?<script>',
                highlight: ['wordpress', '<script']
              }]
            }]
          }, {
            rule: {
              id: 'ua-1337-rx',
              name: 'Hacker rule',
              tags: {
                type: 'user-agent',
                category: 'hacker'
              }
            },
            rule_matches: [{
              operator: 'is_sqli',
              operator_value: '',
              parameters: [{
                address: 'url',
                key_path: [],
                value: '/PG_SLEEP 1',
                highlight: []
              }]
            }]
          }])
        })

        expect(Reporter.reportAttack).to.have.been.calledTwice

        expect(Reporter.reportAttack.firstCall).to.have.been.calledWithExactly({
          id: 'ruleId',
          name: 'ruleName',
          tags: {
            type: 'ruleType',
            category: 'ruleCategory'
          }
        }, {
          operator: 'matchOperator',
          operator_value: 'matchOperatorValue',
          parameters: [{
            address: 'headers',
            key_path: ['user-agent', 0],
            value: 'arachni/v1'
          }, {
            address: 'url',
            key_path: [],
            value: '/wordpress?<script>'
          }],
          highlight: ['arachni/v', 'wordpress', '<script']
        }, false)

        expect(Reporter.reportAttack.secondCall).to.have.been.calledWithExactly({
          id: 'ua-1337-rx',
          name: 'Hacker rule',
          tags: {
            type: 'user-agent',
            category: 'hacker'
          }
        }, {
          operator: 'is_sqli',
          operator_value: '',
          parameters: [{
            address: 'url',
            key_path: [],
            value: '/PG_SLEEP 1'
          }],
          highlight: []
        }, false)
      })

      it('should do nothing when passed no action', () => {
        waf.applyResult({})

        expect(Reporter.reportAttack).to.not.have.been.called
      })
    })

    describe('clear', () => {
      it('should clear the context', () => {
        sinon.stub(Gateway.manager, 'clear')

        waf.wafContextCache.set(waf, {})

        waf.clear()

        expect(waf.ddwaf.dispose).to.have.been.calledOnce
        expect(waf.wafContextCache.get(waf)).to.be.undefined
        expect(Gateway.manager.clear).to.have.been.calledOnce
      })
    })
  })
})

'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { HTTP_REQUEST_PARAMETER } = require('../../../../src/appsec/iast/taint-tracking/source-types')

describe('ldap-injection-analyzer', () => {
  const NOT_TAINTED_QUERY = 'no vulnerable query'
  const TAINTED_QUERY = 'vulnerable query'

  const TaintTrackingMock = {
    getRanges: (iastContext, string) => {
      return string === TAINTED_QUERY
        ? [
            {
              start: 0,
              end: string.length,
              iinfo: {
                parameterName: 'param',
                parameterValue: string,
                type: HTTP_REQUEST_PARAMETER
              }
            }
          ]
        : []
    }
  }

  const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
    '../taint-tracking/operations': TaintTrackingMock
  })
  const ldapInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/ldap-injection-analyzer', {
    './injection-analyzer': InjectionAnalyzer
  })

  ldapInjectionAnalyzer.configure(true)

  it('should subscribe to ldapjs client search channel', () => {
    assert.strictEqual(ldapInjectionAnalyzer._subscriptions.length, 1)
    assert.strictEqual(ldapInjectionAnalyzer._subscriptions[0]._channel.name, 'datadog:ldapjs:client:search')
  })

  it('should not detect vulnerability when no query', () => {
    const isVulnerable = ldapInjectionAnalyzer._isVulnerable()
    assert.strictEqual(isVulnerable, false)
  })

  it('should not detect vulnerability when no vulnerable query', () => {
    const isVulnerable = ldapInjectionAnalyzer._isVulnerable(NOT_TAINTED_QUERY)
    assert.strictEqual(isVulnerable, false)
  })

  it('should detect vulnerability when vulnerable query', () => {
    const isVulnerable = ldapInjectionAnalyzer._isVulnerable(TAINTED_QUERY)
    assert.strictEqual(isVulnerable, true)
  })

  it('should report "LDAP_INJECTION" vulnerability', () => {
    const addVulnerability = sinon.stub()
    const iastContext = {
      rootSpan: {
        context () {
          return {
            toSpanId () {
              return '123'
            }
          }
        }
      }
    }
    const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
      '../iast-context': {
        getIastContext: () => iastContext
      },
      '../overhead-controller': { hasQuota: () => true },
      '../vulnerability-reporter': { addVulnerability }
    })
    const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
      '../taint-tracking/operations': TaintTrackingMock,
      './vulnerability-analyzer': ProxyAnalyzer
    })
    const proxiedLdapInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/ldap-injection-analyzer',
      {
        './injection-analyzer': InjectionAnalyzer
      })
    proxiedLdapInjectionAnalyzer.analyze(TAINTED_QUERY)
    sinon.assert.calledOnce(addVulnerability)
    sinon.assert.calledWithMatch(addVulnerability, {}, { type: 'LDAP_INJECTION' })
  })

  it('should call analyzeAll when datadog:ldapjs:client:search event is published', () => {
    const store = {}
    const iastContext = {}
    const getStore = sinon.stub().returns(store)
    const getIastContext = sinon.stub().returns(iastContext)

    const datadogCore = {
      storage: () => {
        return {
          getStore
        }
      }
    }

    const iastPlugin = proxyquire('../../../../src/appsec/iast/iast-plugin', {
      '../../../../datadog-core': datadogCore,
      './iast-context': { getIastContext }
    })

    const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
      '../iast-plugin': iastPlugin,
      '../overhead-controller': { hasQuota: () => true }
    })
    const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
      '../taint-tracking/operations': TaintTrackingMock,
      './vulnerability-analyzer': ProxyAnalyzer
    })

    const ldapInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/ldap-injection-analyzer', {
      './injection-analyzer': InjectionAnalyzer
    })
    const analyzeAll = sinon.stub(ldapInjectionAnalyzer, 'analyzeAll')
    ldapInjectionAnalyzer.configure(true)

    const onLdapClientSearch = ldapInjectionAnalyzer._subscriptions[0]._handler

    onLdapClientSearch({ base: 'base', filter: 'filter', name: 'datadog:ldapjs:client:search' })

    sinon.assert.calledWith(analyzeAll.firstCall, 'base', 'filter')
  })
})

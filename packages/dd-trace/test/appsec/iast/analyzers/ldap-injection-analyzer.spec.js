'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

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
    expect(ldapInjectionAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(ldapInjectionAnalyzer._subscriptions[0]._channel.name).to.equals('datadog:ldapjs:client:search')
  })

  it('should not detect vulnerability when no query', () => {
    const isVulnerable = ldapInjectionAnalyzer._isVulnerable()
    expect(isVulnerable).to.be.false
  })

  it('should not detect vulnerability when no vulnerable query', () => {
    const isVulnerable = ldapInjectionAnalyzer._isVulnerable(NOT_TAINTED_QUERY)
    expect(isVulnerable).to.be.false
  })

  it('should detect vulnerability when vulnerable query', () => {
    const isVulnerable = ldapInjectionAnalyzer._isVulnerable(TAINTED_QUERY)
    expect(isVulnerable).to.be.true
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
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch({}, { type: 'LDAP_INJECTION' })
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

    expect(analyzeAll.firstCall).to.be.calledWith('base', 'filter')
  })
})

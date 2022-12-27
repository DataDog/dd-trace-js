'use strict'

const proxyquire = require('proxyquire')

describe('ldap-injection-analyzer', () => {
  const NOT_TAINTED_QUERY = 'no vulnerable query'
  const TAINTED_QUERY = 'vulnerable query'

  const TaintTrackingMock = {
    isTainted: (iastContext, string) => {
      return string === TAINTED_QUERY
    }
  }

  const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
    '../taint-tracking/operations': TaintTrackingMock
  })
  const ldapInjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/ldap-injection-analyzer', {
    './injection-analyzer': InjectionAnalyzer
  })

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
})

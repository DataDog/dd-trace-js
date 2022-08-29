'use strict'

const proxyquire = require('proxyquire')
const weakHashAnalyzer = require('../../../../src/appsec/iast/analyzers/weak-hash-analyzer')

describe('weak-hash-analyzer', () => {
  const VULNERABLE_ALGORITHM = 'md4WithRSAEncryption'
  const NON_VULNERABLE_ALGORITHM = 'sha512'

  it('should subscribe to crypto hashing channel', () => {
    expect(weakHashAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(weakHashAnalyzer._subscriptions[0]._channel.name).to.equals('datadog:crypto:hashing:start')
  })

  it('should not detect vulnerability when no algorithm', () => {
    const isVulnerable = weakHashAnalyzer._isVulnerable()
    expect(isVulnerable).to.be.false
  })

  it('should not detect vulnerability when no vulnerable algorithm', () => {
    const isVulnerable = weakHashAnalyzer._isVulnerable(NON_VULNERABLE_ALGORITHM)
    expect(isVulnerable).to.be.false
  })

  it('should detect vulnerability with different casing in algorithm word', () => {
    const isVulnerable = weakHashAnalyzer._isVulnerable(VULNERABLE_ALGORITHM)
    const isVulnerableInLowerCase = weakHashAnalyzer._isVulnerable(VULNERABLE_ALGORITHM.toLowerCase())
    const isVulnerableInUpperCase = weakHashAnalyzer._isVulnerable(VULNERABLE_ALGORITHM.toUpperCase())
    expect(isVulnerable).to.be.true
    expect(isVulnerableInLowerCase).to.be.true
    expect(isVulnerableInUpperCase).to.be.true
  })

  it('should report "WEAK_HASH" vulnerability', () => {
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
    const proxiedWeakHashAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/weak-hash-analyzer',
      {
        './vulnerability-analyzer': ProxyAnalyzer
      })
    proxiedWeakHashAnalyzer.analyze(VULNERABLE_ALGORITHM)
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch({}, { type: 'WEAK_HASH' })
  })
})

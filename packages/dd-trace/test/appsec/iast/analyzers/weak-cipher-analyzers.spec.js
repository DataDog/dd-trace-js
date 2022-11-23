'use strict'

require('../../../../../dd-trace/test/setup/tap')

const proxyquire = require('proxyquire')
const weakCipherAnalyzer = require('../../../../src/appsec/iast/analyzers/weak-cipher-analyzer')
const { testThatRequestHasVulnerability } = require('../utils')

describe('weak-cipher-analyzer', () => {
  const VULNERABLE_CIPHER = 'des-ede-cbc'
  const NON_VULNERABLE_CIPHER = 'sha512'

  it('should subscribe to crypto hashing channel', () => {
    expect(weakCipherAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(weakCipherAnalyzer._subscriptions[0]._channel.name).to.equals('datadog:crypto:cipher:start')
  })

  it('should not detect vulnerability when no algorithm', () => {
    const isVulnerable = weakCipherAnalyzer._isVulnerable()
    expect(isVulnerable).to.be.false
  })

  it('should not detect vulnerability when no vulnerable algorithm', () => {
    const isVulnerable = weakCipherAnalyzer._isVulnerable(NON_VULNERABLE_CIPHER)
    expect(isVulnerable).to.be.false
  })

  it('should detect vulnerability with different casing in algorithm word', () => {
    const isVulnerable = weakCipherAnalyzer._isVulnerable(VULNERABLE_CIPHER)
    const isVulnerableInLowerCase = weakCipherAnalyzer._isVulnerable(VULNERABLE_CIPHER.toLowerCase())
    const isVulnerableInUpperCase = weakCipherAnalyzer._isVulnerable(VULNERABLE_CIPHER.toUpperCase())
    expect(isVulnerable).to.be.true
    expect(isVulnerableInLowerCase).to.be.true
    expect(isVulnerableInUpperCase).to.be.true
  })

  it('should report "WEAK_CIPHER" vulnerability', () => {
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
    const proxiedWeakCipherAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/weak-cipher-analyzer',
      {
        './vulnerability-analyzer': ProxyAnalyzer
      })
    proxiedWeakCipherAnalyzer.analyze(VULNERABLE_CIPHER)
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch({}, { type: 'WEAK_CIPHER' })
  })

  describe('full feature', () => {
    testThatRequestHasVulnerability(function () {
      const crypto = require('crypto')
      const key = '1111111111111111'
      const iv = 'abcdefgh'
      crypto.createCipheriv(VULNERABLE_CIPHER, key, iv)
    }, 'WEAK_CIPHER')
  })
})

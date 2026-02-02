'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const weakCipherAnalyzer = require('../../../../src/appsec/iast/analyzers/weak-cipher-analyzer')
const { prepareTestServerForIast } = require('../utils')

describe('weak-cipher-analyzer', () => {
  const VULNERABLE_CIPHER = 'des-ede-cbc'
  const NON_VULNERABLE_CIPHER = 'sha512'

  weakCipherAnalyzer.configure(true)

  it('should subscribe to crypto hashing channel', () => {
    assert.strictEqual(weakCipherAnalyzer._subscriptions.length, 1)
    assert.strictEqual(weakCipherAnalyzer._subscriptions[0]._channel.name, 'datadog:crypto:cipher:start')
  })

  it('should not detect vulnerability when no algorithm', () => {
    const isVulnerable = weakCipherAnalyzer._isVulnerable()
    assert.strictEqual(isVulnerable, false)
  })

  it('should not detect vulnerability when no vulnerable algorithm', () => {
    const isVulnerable = weakCipherAnalyzer._isVulnerable(NON_VULNERABLE_CIPHER)
    assert.strictEqual(isVulnerable, false)
  })

  it('should detect vulnerability with different casing in algorithm word', () => {
    const isVulnerable = weakCipherAnalyzer._isVulnerable(VULNERABLE_CIPHER)
    const isVulnerableInLowerCase = weakCipherAnalyzer._isVulnerable(VULNERABLE_CIPHER.toLowerCase())
    const isVulnerableInUpperCase = weakCipherAnalyzer._isVulnerable(VULNERABLE_CIPHER.toUpperCase())
    assert.strictEqual(isVulnerable, true)
    assert.strictEqual(isVulnerableInLowerCase, true)
    assert.strictEqual(isVulnerableInUpperCase, true)
  })

  it('should report "WEAK_CIPHER" vulnerability', () => {
    const addVulnerability = sinon.stub()
    const iastContext = {
      rootSpan: {
        context () {
          return {
            toSpanId () {
              return '123'
            },
          }
        },
      },
    }
    const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
      '../iast-context': {
        getIastContext: () => iastContext,
      },
      '../overhead-controller': { hasQuota: () => true },
      '../vulnerability-reporter': { addVulnerability },
    })
    const proxiedWeakCipherAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/weak-cipher-analyzer',
      {
        './vulnerability-analyzer': ProxyAnalyzer,
      })
    proxiedWeakCipherAnalyzer.analyze(VULNERABLE_CIPHER)
    sinon.assert.calledOnce(addVulnerability)
    sinon.assert.calledWithMatch(addVulnerability, {}, { type: 'WEAK_CIPHER' })
  })

  prepareTestServerForIast('full feature', (testThatRequestHasVulnerability) => {
    testThatRequestHasVulnerability(() => {
      const crypto = require('crypto')
      const key = '1111111111111111'
      const iv = 'abcdefgh'
      crypto.createCipheriv(VULNERABLE_CIPHER, key, iv)
    }, 'WEAK_CIPHER', { occurrences: 1 })
  })
})

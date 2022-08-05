'use strict'

const proxyquire = require('proxyquire')
const { IAST_CONTEXT_KEY } = require('../../../../src/appsec/iast')

describe('weak-hash-analyzer', () => {
  const VULNERABLE_ALGORITHM = 'md4WithRSAEncryption'
  const NON_VULNERABLE_ALGORITHM = 'sha512'

  let datadogCore
  let weakHashAnalyzer
  beforeEach(() => {
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }
    weakHashAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/weak-hash-analyzer', {
      '../../../../../datadog-core': datadogCore
    })
  })
  afterEach(() => {
    sinon.restore()
  })

  it('should subscribe to crypto hashing channel', () => {
    expect(weakHashAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(weakHashAnalyzer._subscriptions[0]._channel.name).to.equals('asm:crypto:hashing:start')
  })

  it('should analyze hashing algorithm', () => {
    const store = {
      [IAST_CONTEXT_KEY]: { vulnerabilities: [], rootSpan: {} }
    }
    datadogCore.storage.getStore.returns(store)

    sinon.stub(weakHashAnalyzer, 'analyze')

    weakHashAnalyzer._handler({ algorithm: VULNERABLE_ALGORITHM })
    expect(weakHashAnalyzer.analyze).to.have.been.calledOnceWithExactly(VULNERABLE_ALGORITHM, store[IAST_CONTEXT_KEY])
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
})

'use strict'

const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')

const { copyFileToTmp, prepareTestServerForIast } = require('../utils')
const { clearCache } = require('../../../../src/appsec/iast/vulnerability-reporter')
const weakRandomnessAnalyzer = require('../../../../src/appsec/iast/analyzers/weak-randomness-analyzer')

describe('weak-randomness-analyzer', () => {
  weakRandomnessAnalyzer.configure(true)

  it('should subscribe to Math random call channel', () => {
    expect(weakRandomnessAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(weakRandomnessAnalyzer._subscriptions[0]._channel.name).to.equals('datadog:random:call')
  })

  it('should detect Math.random as vulnerable', () => {
    const isVulnerable = weakRandomnessAnalyzer._isVulnerable(Math)
    expect(isVulnerable).to.be.true
  })

  it('should not detect custom random as vulnerable', () => {
    const myMath = {
      random: function () {
        return 4 // chosen by fair dice roll - guaranteed to be random
      }
    }
    const isVulnerable = weakRandomnessAnalyzer._isVulnerable(myMath)
    expect(isVulnerable).to.be.false
  })

  it('should not detect vulnerability when checking empty object', () => {
    const isVulnerable = weakRandomnessAnalyzer._isVulnerable({})
    expect(isVulnerable).to.be.false
  })

  it('should not detect vulnerability when no target', () => {
    const isVulnerable = weakRandomnessAnalyzer._isVulnerable()
    expect(isVulnerable).to.be.false
  })

  it('should report "WEAK_RANDOMNESS" vulnerability', () => {
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
    const proxiedWeakRandomnessAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/weak-randomness-analyzer',
      {
        './vulnerability-analyzer': ProxyAnalyzer
      })
    proxiedWeakRandomnessAnalyzer.analyze(Math)
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch({}, { type: 'WEAK_RANDOMNESS' })
  })

  describe('Math.random instrumentation', () => {
    const randomFunctionsFile = path.join(__dirname, 'resources/random-functions.js')
    let instrumentedRandomFunctionsFile
    beforeEach(() => {
      instrumentedRandomFunctionsFile = copyFileToTmp(randomFunctionsFile)
    })

    afterEach(() => {
      fs.unlinkSync(instrumentedRandomFunctionsFile)
      clearCache()
    })

    prepareTestServerForIast('full feature', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      describe('should detect weak randomness when calling Math.random', () => {
        testThatRequestHasVulnerability(() => {
          require(instrumentedRandomFunctionsFile).weakRandom()
        }, 'WEAK_RANDOMNESS', { occurrences: 1 })
      })

      describe('should not detect weak randomness when calling safe random function', () => {
        testThatRequestHasNoVulnerability(() => {
          require(instrumentedRandomFunctionsFile).safeRandom()
        }, 'WEAK_RANDOMNESS')
      })

      describe('should not detect weak randomness when calling custom random function', () => {
        testThatRequestHasNoVulnerability(() => {
          require(instrumentedRandomFunctionsFile).customRandom()
        }, 'WEAK_RANDOMNESS')
      })
    })
  })
})

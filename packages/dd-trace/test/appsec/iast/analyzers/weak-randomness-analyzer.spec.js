'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const weakRandomnessAnalyzer = require('../../../../src/appsec/iast/analyzers/weak-randomness-analyzer')
const { clearCache } = require('../../../../src/appsec/iast/vulnerability-reporter')
const { prepareTestServerForIast } = require('../utils')

describe('weak-randomness-analyzer', () => {
  weakRandomnessAnalyzer.configure(true)

  it('should subscribe to Math random call channel', () => {
    assert.strictEqual(weakRandomnessAnalyzer._subscriptions.length, 1)
    assert.strictEqual(weakRandomnessAnalyzer._subscriptions[0]._channel.name, 'datadog:random:call')
  })

  it('should detect Math.random as vulnerable', () => {
    const isVulnerable = weakRandomnessAnalyzer._isVulnerable(Math.random)
    assert.strictEqual(isVulnerable, true)
  })

  it('should not detect custom random as vulnerable', () => {
    function random () {
      return 4 // chosen by fair dice roll - guaranteed to be random
    }
    const isVulnerable = weakRandomnessAnalyzer._isVulnerable(random)
    assert.strictEqual(isVulnerable, false)
  })

  it('should not detect vulnerability when checking empty object', () => {
    const isVulnerable = weakRandomnessAnalyzer._isVulnerable({})
    assert.strictEqual(isVulnerable, false)
  })

  it('should not detect vulnerability when no target', () => {
    const isVulnerable = weakRandomnessAnalyzer._isVulnerable()
    assert.strictEqual(isVulnerable, false)
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
    proxiedWeakRandomnessAnalyzer.analyze(Math.random)
    sinon.assert.calledOnce(addVulnerability)
    sinon.assert.calledWithMatch(addVulnerability, {}, { type: 'WEAK_RANDOMNESS' })
  })

  describe('Math.random instrumentation', () => {
    const randomFunctionsPath = path.join(os.tmpdir(), 'random-functions.js')

    beforeEach(() => {
      fs.copyFileSync(
        path.join(__dirname, 'resources', 'random-functions.js'),
        randomFunctionsPath
      )
    })

    afterEach(() => {
      fs.unlinkSync(randomFunctionsPath)
      clearCache()
    })

    prepareTestServerForIast('full feature', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      describe('should detect weak randomness when calling Math.random', () => {
        testThatRequestHasVulnerability(() => {
          require(randomFunctionsPath).weakRandom()
        },
        'WEAK_RANDOMNESS',
        {
          occurrences: 1,
          location: {
            path: randomFunctionsPath,
            line: 4
          }
        })
      })

      describe('should not detect weak randomness when calling safe random function', () => {
        testThatRequestHasNoVulnerability(() => {
          require(randomFunctionsPath).safeRandom()
        }, 'WEAK_RANDOMNESS')
      })

      describe('should not detect weak randomness when calling custom random function', () => {
        testThatRequestHasNoVulnerability(() => {
          require(randomFunctionsPath).customRandom()
        }, 'WEAK_RANDOMNESS')
      })
    })
  })
})

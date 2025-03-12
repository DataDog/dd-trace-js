'use strict'

const chai = require('chai')

const BaseLLMObsSpanWriter = require('../../src/llmobs/writers/spans/base')
const LLMObsEvalMetricsWriter = require('../../src/llmobs/writers/evaluations')

const MOCK_STRING = Symbol('string')
const MOCK_NUMBER = Symbol('number')
const MOCK_ANY = Symbol('any')

/**
 * Sets up the test environment by adding custom chai assertions and stubbing methods.
 *
 * @returns {{ getSpanEvents: () => any[], getEvalMetrics: () => any[] }}
 * An object with methods to get span events and evaluation metrics.
 */
function setup () {
  chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

  before(() => {
    process.removeAllListeners('beforeExit')

    sinon.stub(BaseLLMObsSpanWriter.prototype, 'append')
    sinon.stub(LLMObsEvalMetricsWriter.prototype, 'append')
  })

  afterEach(() => {
    BaseLLMObsSpanWriter.prototype.append.reset()
    LLMObsEvalMetricsWriter.prototype.append.reset()
  })

  after(() => {
    BaseLLMObsSpanWriter.prototype.append.restore()
    LLMObsEvalMetricsWriter.prototype.append.restore()
  })

  return {
    getSpanEvents () {
      return BaseLLMObsSpanWriter.prototype.append.getCalls().map(call => call.args[0])
    },
    getEvalMetrics () {
      return LLMObsEvalMetricsWriter.prototype.append.getCalls().map(call => call.args[0])
    }
  }
}

function deepEqualWithMockValues (expected) {
  const actual = this._obj // "this" here refers to the chai instance

  if (actual == null) {
    // fail the test
    chai.expect(actual).to.exist
  }

  for (const key in actual) {
    if (expected[key] === MOCK_STRING) {
      chai.expect(typeof actual[key], `key ${key}`).to.equal('string')
    } else if (expected[key] === MOCK_NUMBER) {
      chai.expect(typeof actual[key], `key ${key}`).to.equal('number')
    } else if (expected[key] === MOCK_ANY) {
      chai.expect(actual[key], `key ${key}`).to.exist
    } else if (Array.isArray(expected[key])) {
      const sortedExpected = [...expected[key].sort()]
      const sortedActual = [...actual[key].sort()]
      chai.expect(sortedActual, `key: ${key}`).to.deep.equal(sortedExpected)
    } else if (typeof expected[key] === 'object') {
      chai.expect(actual[key], `key: ${key}`).to.deepEqualWithMockValues(expected[key])
    } else {
      chai.expect(actual[key], `key: ${key}`).to.equal(expected[key])
    }
  }
}

module.exports = {
  setup,
  MOCK_STRING,
  MOCK_NUMBER,
  MOCK_ANY
}

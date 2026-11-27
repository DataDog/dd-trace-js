'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { getEvaluatorCapabilities } = require('../../src/openfeature/evaluator-capabilities')

describe('evaluator capabilities', () => {
  it('does not advertise unsupported dependent flags', () => {
    assert.deepStrictEqual(getEvaluatorCapabilities(), [])
  })
})

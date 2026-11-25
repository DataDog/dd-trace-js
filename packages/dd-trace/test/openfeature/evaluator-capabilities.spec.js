'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  DEPENDENT_FLAG_VARIANT_KEY_V1,
  getEvaluatorCapabilities,
} = require('../../src/openfeature/evaluator-capabilities')

describe('evaluator capabilities', () => {
  it('advertises dependent flag evaluation support', () => {
    assert.deepStrictEqual(getEvaluatorCapabilities(), [DEPENDENT_FLAG_VARIANT_KEY_V1])
  })
})

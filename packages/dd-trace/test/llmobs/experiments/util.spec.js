'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const {
  inferMetricType,
  isPlainObject,
  normalizeEvaluators,
  validateEvaluatorName,
} = require('../../../src/llmobs/experiments/util')

describe('LLMObs Experiments util', () => {
  it('validates evaluator names against the backend contract', () => {
    validateEvaluatorName('ok_Name-1')

    assert.throws(() => validateEvaluatorName('bad name'), /invalid/)
    assert.throws(() => validateEvaluatorName('bad.name'), /invalid/)
    assert.throws(() => validateEvaluatorName(''), /empty/)
    assert.throws(() => validateEvaluatorName(1), /must be a string/)
  })

  it('normalizes evaluator maps and arrays', () => {
    function namedEvaluator () {}

    assert.deepEqual(normalizeEvaluators({ ok: namedEvaluator }, 'row'), [['ok', namedEvaluator]])
    assert.deepEqual(normalizeEvaluators([namedEvaluator], 'summary'), [['namedEvaluator', namedEvaluator]])
    assert.throws(() => normalizeEvaluators({ 'bad.name': namedEvaluator }, 'row'), /invalid/)
    assert.throws(() => normalizeEvaluators([true], 'summary'), /summary evaluator must be a function/)
  })

  it('identifies plain objects for JSON metric inference', () => {
    assert.equal(isPlainObject({}), true)
    assert.equal(isPlainObject(Object.create(null)), true)
    assert.equal(isPlainObject([]), false)
    assert.equal(isPlainObject(new Date()), false)
    assert.equal(isPlainObject(null), false)

    assert.equal(inferMetricType({ x: 1 }), 'json')
    assert.equal(inferMetricType(['Pass']), 'categorical')
    assert.equal(inferMetricType(true), 'boolean')
    assert.equal(inferMetricType(0.5), 'score')
  })
})

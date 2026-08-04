'use strict'

const assert = require('node:assert/strict')
const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../../src/log')

const {
  generateRunId,
  inferMetricType,
  normalizeEvaluators,
  normalizeJsonMetricValue,
  validateEvaluatorName,
} = require('../../../src/llmobs/experiments/util')

describe('LLMObs Experiments util', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('generates UUID run ids', () => {
    const first = generateRunId()
    const second = generateRunId()

    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.match(second, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.notEqual(first, second)
  })

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

  it('warns and keeps the last array evaluator when inferred names collide', () => {
    const warn = sinon.spy(log, 'warn')
    function duplicate () {}
    const last = function duplicate () {}

    assert.deepEqual(normalizeEvaluators([duplicate, last], 'row'), [['duplicate', last]])
    sinon.assert.calledWith(
      warn,
      'Duplicate %s evaluator name %s; previous evaluator will be overwritten',
      'row',
      'duplicate'
    )
  })

  it('infers metric types with a normalized JSON fallback', () => {
    assert.equal(inferMetricType({ x: 1 }), 'json')
    assert.equal(inferMetricType(Object.create(null)), 'json')
    assert.equal(inferMetricType(['Pass']), 'json')
    assert.equal(inferMetricType(new Date()), 'json')
    assert.equal(inferMetricType(null), 'json')
    assert.equal(inferMetricType(Number.NaN), 'json')
    assert.equal(inferMetricType(Number.POSITIVE_INFINITY), 'json')
    assert.equal(inferMetricType('label'), 'categorical')
    assert.equal(inferMetricType(true), 'boolean')
    assert.equal(inferMetricType(0.5), 'score')
  })

  it('normalizes JSON metric values into backend-safe objects', () => {
    const circular = { ok: true }
    circular.self = circular
    const error = new TypeError('bad')

    assert.deepEqual(normalizeJsonMetricValue({ nested: { value: 1 }, circular }), {
      nested: { value: 1 },
      circular: { ok: true, self: '[Circular]' },
    })
    assert.deepEqual(normalizeJsonMetricValue(['Pass', undefined, 1n]), { value: ['Pass', null, '1'] })
    assert.deepEqual(normalizeJsonMetricValue(Number.NaN), { value: 'NaN' })
    assert.deepEqual(normalizeJsonMetricValue(null), { value: null })
    assert.deepEqual(normalizeJsonMetricValue(error), {
      type: 'TypeError',
      message: 'bad',
      stack: error.stack,
    })
  })
})

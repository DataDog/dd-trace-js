'use strict'

const assert = require('node:assert/strict')
const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../../src/log')

const {
  buildTags,
  durationNs,
  generateRunId,
  inferMetricType,
  mergeTags,
  normalizeEvaluators,
  normalizeJsonMetricValue,
  recordTagsToObject,
  timestampMs,
  validateEvaluatorName,
  validateTagsList,
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

  it('merges tags with override values taking precedence', () => {
    assert.deepEqual(mergeTags({ shared: 'base', base: true }, { shared: 'override', override: true }), {
      shared: 'override',
      base: true,
      override: true,
    })
    assert.deepEqual(mergeTags(undefined, { tag: 'value' }), { tag: 'value' })
    assert.deepEqual(mergeTags({ tag: 'value' }, undefined), { tag: 'value' })
  })

  it('preserves repeated record tag keys in object and wire representations', () => {
    const recordTags = ['topic:math', 'topic:logic', 'source:test']

    assert.deepEqual(recordTagsToObject(recordTags), {
      topic: ['math', 'logic'],
      source: 'test',
    })
    assert.deepEqual(buildTags(recordTagsToObject(recordTags), { experiment_id: 'exp' }), [
      'topic:math',
      'topic:logic',
      'source:test',
      'experiment_id:exp',
    ])
  })

  it('preserves record tags that collide with object prototype keys', () => {
    const tags = recordTagsToObject(['toString:value', '__proto__:prototype', 'constructor:class'])

    assert.equal(tags.toString, 'value')
    assert.equal(Object.getOwnPropertyDescriptor(tags, '__proto__').value, 'prototype')
    assert.equal(tags.constructor, 'class')
    assert.equal(Object.hasOwn(tags, '__proto__'), true)
  })

  it('rejects record tags without a key', () => {
    assert.throws(() => validateTagsList([':value']), /malformed/)
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

  it('normalizes timestamps to milliseconds with fallback for invalid values', () => {
    const fallback = Date.UTC(2026, 0, 1)

    assert.equal(timestampMs(new Date('2026-01-01T00:00:01.000Z'), fallback), Date.UTC(2026, 0, 1, 0, 0, 1))
    assert.equal(timestampMs('2026-01-01T00:00:02.000Z', fallback), Date.UTC(2026, 0, 1, 0, 0, 2))
    assert.equal(timestampMs(1234, fallback), 1234)
    assert.equal(timestampMs(new Date('invalid'), fallback), fallback)
    assert.equal(timestampMs(Number.NaN, fallback), fallback)
    assert.equal(timestampMs(null, fallback), fallback)
  })

  it('normalizes durations to nanoseconds with non-negative fallbacks', () => {
    const startMs = Date.UTC(2026, 0, 1)

    assert.equal(durationNs({ durationMs: 1.5 }, startMs), 1_500_000)
    assert.equal(durationNs({ durationMs: -1 }, startMs), 0)
    assert.equal(durationNs({ completedAt: '2026-01-01T00:00:02.000Z' }, startMs), 2_000_000_000)
    assert.equal(durationNs({ completedAt: new Date('2025-12-31T23:59:59.000Z') }, startMs), 0)
    assert.equal(durationNs({ completedAt: new Date('invalid') }, startMs), 0)
    assert.equal(durationNs({}, startMs), 0)
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

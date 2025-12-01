'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('./setup/core')

const id = require('../src/id')
const SpanContext = require('../src/opentracing/span_context')

function createDummySpans () {
  const operations = [
    'operation',
    'sub_operation',
    'second_operation',
    'sub_second_operation_1',
    'sub_second_operation_2',
    'sub_sub_second_operation_2',
    'custom_service_span_1',
    'custom_service_span_2',
    'renamed_operation',
    'tagged_operation',
    'resource_named_operation'
  ]

  const ids = [
    id('0234567812345671'),
    id('0234567812345672'),
    id('0234567812345673'),
    id('0234567812345674'),
    id('0234567812345675'),
    id('0234567812345676'),
    id('0234567812345677'),
    id('0234567812345678'),
    id('0234567812345679'),
    id('0234567812345680'),
    id('0234567812345681')
  ]

  const spans = []
  const spanContexts = []

  for (let idx = 0; idx < operations.length; idx++) {
    const operation = operations[idx]
    const id = ids[idx]
    const spanContext = {
      _spanId: id,
      _sampling: {},
      _trace: {
        started: []
      },
      _name: operation,
      _tags: {}
    }

    // Give first span a custom service name
    if ([6, 7].includes(idx)) {
      spanContext._tags['service.name'] = 'span-service'
    }

    if (idx === 8) {
      spanContext._name = 'renamed'
    }

    if (idx === 9) {
      spanContext._tags.tagged = 'yup'
      spanContext._tags.and = 'this'
      spanContext._tags.not = 'this'
    }

    if (idx === 10) {
      spanContext._tags['resource.name'] = 'named'
    }

    const span = {
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _name: operation
    }

    spanContexts.push(spanContext)
    spans.push(span)
  }

  return { spans, spanContexts }
}

describe('sampling rule', () => {
  let spans
  let spanContexts
  let SamplingRule
  let rule

  beforeEach(() => {
    const info = createDummySpans()
    spans = info.spans
    spanContexts = info.spanContexts

    spanContexts[0]._trace.started.push(...spans)

    SamplingRule = require('../src/sampling_rule')
  })

  describe('match', () => {
    it('should match with exact strings', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation'
      })

      assert.strictEqual(rule.match(spans[0]), true)
      assert.strictEqual(rule.match(spans[1]), false)
      assert.strictEqual(rule.match(spans[2]), false)
      assert.strictEqual(rule.match(spans[3]), false)
      assert.strictEqual(rule.match(spans[4]), false)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), false)
      assert.strictEqual(rule.match(spans[10]), false)
    })

    it('should match with case-insensitive strings', () => {
      const lowerCaseRule = new SamplingRule({
        service: 'test',
        name: 'operation'
      })

      const mixedCaseRule = new SamplingRule({
        service: 'teSt',
        name: 'oPeration'
      })

      assert.strictEqual(lowerCaseRule.match(spans[0]), mixedCaseRule.match(spans[0]))
      assert.strictEqual(lowerCaseRule.match(spans[1]), mixedCaseRule.match(spans[1]))
      assert.strictEqual(lowerCaseRule.match(spans[2]), mixedCaseRule.match(spans[2]))
      assert.strictEqual(lowerCaseRule.match(spans[3]), mixedCaseRule.match(spans[3]))
      assert.strictEqual(lowerCaseRule.match(spans[4]), mixedCaseRule.match(spans[4]))
      assert.strictEqual(lowerCaseRule.match(spans[5]), mixedCaseRule.match(spans[5]))
      assert.strictEqual(lowerCaseRule.match(spans[6]), mixedCaseRule.match(spans[6]))
      assert.strictEqual(lowerCaseRule.match(spans[7]), mixedCaseRule.match(spans[7]))
      assert.strictEqual(lowerCaseRule.match(spans[8]), mixedCaseRule.match(spans[8]))
      assert.strictEqual(lowerCaseRule.match(spans[9]), mixedCaseRule.match(spans[9]))
      assert.strictEqual(lowerCaseRule.match(spans[10]), mixedCaseRule.match(spans[10]))
    })

    it('should match with regexp', () => {
      rule = new SamplingRule({
        service: /test/,
        name: /op.*/
      })

      assert.strictEqual(rule.match(spans[0]), true)
      assert.strictEqual(rule.match(spans[1]), true)
      assert.strictEqual(rule.match(spans[2]), true)
      assert.strictEqual(rule.match(spans[3]), true)
      assert.strictEqual(rule.match(spans[4]), true)
      assert.strictEqual(rule.match(spans[5]), true)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), true)
      assert.strictEqual(rule.match(spans[10]), true)
    })

    it('should match with postfix glob', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'op*'
      })

      assert.strictEqual(rule.match(spans[0]), true)
      assert.strictEqual(rule.match(spans[1]), false)
      assert.strictEqual(rule.match(spans[2]), false)
      assert.strictEqual(rule.match(spans[3]), false)
      assert.strictEqual(rule.match(spans[4]), false)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), false)
      assert.strictEqual(rule.match(spans[10]), false)
    })

    it('should match with prefix glob', () => {
      rule = new SamplingRule({
        service: 'test',
        name: '*operation'
      })

      assert.strictEqual(rule.match(spans[0]), true)
      assert.strictEqual(rule.match(spans[1]), true)
      assert.strictEqual(rule.match(spans[2]), true)
      assert.strictEqual(rule.match(spans[3]), false)
      assert.strictEqual(rule.match(spans[4]), false)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), true)
      assert.strictEqual(rule.match(spans[10]), true)
    })

    it('should match with single character any matcher', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'o?eration'
      })

      assert.strictEqual(rule.match(spans[0]), true)
      assert.strictEqual(rule.match(spans[1]), false)
      assert.strictEqual(rule.match(spans[2]), false)
      assert.strictEqual(rule.match(spans[3]), false)
      assert.strictEqual(rule.match(spans[4]), false)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), false)
      assert.strictEqual(rule.match(spans[10]), false)
    })

    it('should consider missing service as match-all for service name', () => {
      rule = new SamplingRule({
        name: 'sub_second_operation_*'
      })

      assert.strictEqual(rule.match(spans[0]), false)
      assert.strictEqual(rule.match(spans[1]), false)
      assert.strictEqual(rule.match(spans[2]), false)
      // Only 3 and 4 should match because of the name pattern
      assert.strictEqual(rule.match(spans[3]), true)
      assert.strictEqual(rule.match(spans[4]), true)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), false)
      assert.strictEqual(rule.match(spans[10]), false)
    })

    it('should consider missing name as match-all for span name', () => {
      rule = new SamplingRule({
        service: 'test'
      })

      assert.strictEqual(rule.match(spans[0]), true)
      assert.strictEqual(rule.match(spans[1]), true)
      assert.strictEqual(rule.match(spans[2]), true)
      assert.strictEqual(rule.match(spans[3]), true)
      assert.strictEqual(rule.match(spans[4]), true)
      assert.strictEqual(rule.match(spans[5]), true)
      assert.strictEqual(rule.match(spans[8]), true)
      assert.strictEqual(rule.match(spans[9]), true)
      assert.strictEqual(rule.match(spans[10]), true)
      // Should not match because of different service name
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
    })

    it('should use span service name tags where present', () => {
      rule = new SamplingRule({
        service: 'span-service'
      })

      assert.strictEqual(rule.match(spans[0]), false)
      assert.strictEqual(rule.match(spans[1]), false)
      assert.strictEqual(rule.match(spans[2]), false)
      assert.strictEqual(rule.match(spans[3]), false)
      assert.strictEqual(rule.match(spans[4]), false)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), true)
      assert.strictEqual(rule.match(spans[7]), true)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), false)
      assert.strictEqual(rule.match(spans[10]), false)
    })

    it('should match renamed spans', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'renamed'
      })

      assert.strictEqual(rule.match(spans[0]), false)
      assert.strictEqual(rule.match(spans[1]), false)
      assert.strictEqual(rule.match(spans[2]), false)
      assert.strictEqual(rule.match(spans[3]), false)
      assert.strictEqual(rule.match(spans[4]), false)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), true)
      assert.strictEqual(rule.match(spans[9]), false)
      assert.strictEqual(rule.match(spans[10]), false)
    })

    it('should match tag sets', () => {
      rule = new SamplingRule({
        tags: {
          tagged: 'yup',
          and: 'this'
        }
      })

      assert.strictEqual(rule.match(spans[0]), false)
      assert.strictEqual(rule.match(spans[1]), false)
      assert.strictEqual(rule.match(spans[2]), false)
      assert.strictEqual(rule.match(spans[3]), false)
      assert.strictEqual(rule.match(spans[4]), false)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), true)
      assert.strictEqual(rule.match(spans[10]), false)
    })

    it('should match resource name', () => {
      rule = new SamplingRule({
        resource: 'named'
      })

      assert.strictEqual(rule.match(spans[0]), false)
      assert.strictEqual(rule.match(spans[1]), false)
      assert.strictEqual(rule.match(spans[2]), false)
      assert.strictEqual(rule.match(spans[3]), false)
      assert.strictEqual(rule.match(spans[4]), false)
      assert.strictEqual(rule.match(spans[5]), false)
      assert.strictEqual(rule.match(spans[6]), false)
      assert.strictEqual(rule.match(spans[7]), false)
      assert.strictEqual(rule.match(spans[8]), false)
      assert.strictEqual(rule.match(spans[9]), false)
      assert.strictEqual(rule.match(spans[10]), true)
    })
  })

  describe('sampleRate', () => {
    beforeEach(() => {
      sinon.stub(Math, 'random').returns(0.5)
    })

    afterEach(() => {
      Math.random.restore()
    })

    it('should sample on allowed sample rate', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0,
        maxPerSecond: 1
      })

      assert.strictEqual(rule.sample(new SpanContext({ traceId: id() })), true)
    })

    it('should not sample on non-allowed sample rate', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 0.3,
        maxPerSecond: 1
      })

      assert.strictEqual(rule.sample(new SpanContext({ traceId: id('6148299799767393280', 10) })), false)
    })
  })

  describe('maxPerSecond', () => {
    it('should not create limiter without finite maxPerSecond', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0
      })

      assert.strictEqual(rule._limiter, undefined)
      assert.strictEqual(rule.maxPerSecond, undefined)
    })

    it('should create limiter with finite maxPerSecond', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0,
        maxPerSecond: 123
      })

      assert.notStrictEqual(rule._limiter, undefined)
      assert.strictEqual(rule.maxPerSecond, 123)
    })

    it('should not sample spans past the rate limit', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0,
        maxPerSecond: 1
      })

      const spanContext = new SpanContext({ traceId: id('2986627970102095326', 10) })

      assert.strictEqual(rule.sample(spanContext), true)
      assert.strictEqual(rule.sample(spanContext), false)
    })

    it('should allow unlimited rate limits', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0
      })

      for (let i = 0; i < 1e3; i++) {
        assert.strictEqual(rule.sample(new SpanContext({ traceId: id() })), true)
      }
    })

    it('should sample if enough time has elapsed', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0,
        maxPerSecond: 1
      })

      const clock = sinon.useFakeTimers({
        now: new Date(),
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime']
      })
      assert.strictEqual(rule.sample(new SpanContext({ traceId: id() })), true)
      assert.strictEqual(rule.sample(new SpanContext({ traceId: id() })), false)
      clock.tick(1000)
      assert.strictEqual(rule.sample(new SpanContext({ traceId: id() })), true)
    })
  })
})

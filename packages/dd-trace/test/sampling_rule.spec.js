'use strict'

const { expect } = require('chai')
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

      expect(rule.match(spans[0])).to.equal(true)
      expect(rule.match(spans[1])).to.equal(false)
      expect(rule.match(spans[2])).to.equal(false)
      expect(rule.match(spans[3])).to.equal(false)
      expect(rule.match(spans[4])).to.equal(false)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(false)
      expect(rule.match(spans[10])).to.equal(false)
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

      expect(lowerCaseRule.match(spans[0])).to.equal(mixedCaseRule.match(spans[0]))
      expect(lowerCaseRule.match(spans[1])).to.equal(mixedCaseRule.match(spans[1]))
      expect(lowerCaseRule.match(spans[2])).to.equal(mixedCaseRule.match(spans[2]))
      expect(lowerCaseRule.match(spans[3])).to.equal(mixedCaseRule.match(spans[3]))
      expect(lowerCaseRule.match(spans[4])).to.equal(mixedCaseRule.match(spans[4]))
      expect(lowerCaseRule.match(spans[5])).to.equal(mixedCaseRule.match(spans[5]))
      expect(lowerCaseRule.match(spans[6])).to.equal(mixedCaseRule.match(spans[6]))
      expect(lowerCaseRule.match(spans[7])).to.equal(mixedCaseRule.match(spans[7]))
      expect(lowerCaseRule.match(spans[8])).to.equal(mixedCaseRule.match(spans[8]))
      expect(lowerCaseRule.match(spans[9])).to.equal(mixedCaseRule.match(spans[9]))
      expect(lowerCaseRule.match(spans[10])).to.equal(mixedCaseRule.match(spans[10]))
    })

    it('should match with regexp', () => {
      rule = new SamplingRule({
        service: /test/,
        name: /op.*/
      })

      expect(rule.match(spans[0])).to.equal(true)
      expect(rule.match(spans[1])).to.equal(true)
      expect(rule.match(spans[2])).to.equal(true)
      expect(rule.match(spans[3])).to.equal(true)
      expect(rule.match(spans[4])).to.equal(true)
      expect(rule.match(spans[5])).to.equal(true)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(true)
      expect(rule.match(spans[10])).to.equal(true)
    })

    it('should match with postfix glob', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'op*'
      })

      expect(rule.match(spans[0])).to.equal(true)
      expect(rule.match(spans[1])).to.equal(false)
      expect(rule.match(spans[2])).to.equal(false)
      expect(rule.match(spans[3])).to.equal(false)
      expect(rule.match(spans[4])).to.equal(false)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(false)
      expect(rule.match(spans[10])).to.equal(false)
    })

    it('should match with prefix glob', () => {
      rule = new SamplingRule({
        service: 'test',
        name: '*operation'
      })

      expect(rule.match(spans[0])).to.equal(true)
      expect(rule.match(spans[1])).to.equal(true)
      expect(rule.match(spans[2])).to.equal(true)
      expect(rule.match(spans[3])).to.equal(false)
      expect(rule.match(spans[4])).to.equal(false)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(true)
      expect(rule.match(spans[10])).to.equal(true)
    })

    it('should match with single character any matcher', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'o?eration'
      })

      expect(rule.match(spans[0])).to.equal(true)
      expect(rule.match(spans[1])).to.equal(false)
      expect(rule.match(spans[2])).to.equal(false)
      expect(rule.match(spans[3])).to.equal(false)
      expect(rule.match(spans[4])).to.equal(false)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(false)
      expect(rule.match(spans[10])).to.equal(false)
    })

    it('should consider missing service as match-all for service name', () => {
      rule = new SamplingRule({
        name: 'sub_second_operation_*'
      })

      expect(rule.match(spans[0])).to.equal(false)
      expect(rule.match(spans[1])).to.equal(false)
      expect(rule.match(spans[2])).to.equal(false)
      // Only 3 and 4 should match because of the name pattern
      expect(rule.match(spans[3])).to.equal(true)
      expect(rule.match(spans[4])).to.equal(true)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(false)
      expect(rule.match(spans[10])).to.equal(false)
    })

    it('should consider missing name as match-all for span name', () => {
      rule = new SamplingRule({
        service: 'test'
      })

      expect(rule.match(spans[0])).to.equal(true)
      expect(rule.match(spans[1])).to.equal(true)
      expect(rule.match(spans[2])).to.equal(true)
      expect(rule.match(spans[3])).to.equal(true)
      expect(rule.match(spans[4])).to.equal(true)
      expect(rule.match(spans[5])).to.equal(true)
      expect(rule.match(spans[8])).to.equal(true)
      expect(rule.match(spans[9])).to.equal(true)
      expect(rule.match(spans[10])).to.equal(true)
      // Should not match because of different service name
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
    })

    it('should use span service name tags where present', () => {
      rule = new SamplingRule({
        service: 'span-service'
      })

      expect(rule.match(spans[0])).to.equal(false)
      expect(rule.match(spans[1])).to.equal(false)
      expect(rule.match(spans[2])).to.equal(false)
      expect(rule.match(spans[3])).to.equal(false)
      expect(rule.match(spans[4])).to.equal(false)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(true)
      expect(rule.match(spans[7])).to.equal(true)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(false)
      expect(rule.match(spans[10])).to.equal(false)
    })

    it('should match renamed spans', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'renamed'
      })

      expect(rule.match(spans[0])).to.equal(false)
      expect(rule.match(spans[1])).to.equal(false)
      expect(rule.match(spans[2])).to.equal(false)
      expect(rule.match(spans[3])).to.equal(false)
      expect(rule.match(spans[4])).to.equal(false)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(true)
      expect(rule.match(spans[9])).to.equal(false)
      expect(rule.match(spans[10])).to.equal(false)
    })

    it('should match tag sets', () => {
      rule = new SamplingRule({
        tags: {
          tagged: 'yup',
          and: 'this'
        }
      })

      expect(rule.match(spans[0])).to.equal(false)
      expect(rule.match(spans[1])).to.equal(false)
      expect(rule.match(spans[2])).to.equal(false)
      expect(rule.match(spans[3])).to.equal(false)
      expect(rule.match(spans[4])).to.equal(false)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(true)
      expect(rule.match(spans[10])).to.equal(false)
    })

    it('should match resource name', () => {
      rule = new SamplingRule({
        resource: 'named'
      })

      expect(rule.match(spans[0])).to.equal(false)
      expect(rule.match(spans[1])).to.equal(false)
      expect(rule.match(spans[2])).to.equal(false)
      expect(rule.match(spans[3])).to.equal(false)
      expect(rule.match(spans[4])).to.equal(false)
      expect(rule.match(spans[5])).to.equal(false)
      expect(rule.match(spans[6])).to.equal(false)
      expect(rule.match(spans[7])).to.equal(false)
      expect(rule.match(spans[8])).to.equal(false)
      expect(rule.match(spans[9])).to.equal(false)
      expect(rule.match(spans[10])).to.equal(true)
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

      expect(rule.sample(new SpanContext({ traceId: id() }))).to.equal(true)
    })

    it('should not sample on non-allowed sample rate', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 0.3,
        maxPerSecond: 1
      })

      expect(rule.sample(new SpanContext({ traceId: id('6148299799767393280', 10) }))).to.equal(false)
    })
  })

  describe('maxPerSecond', () => {
    it('should not create limiter without finite maxPerSecond', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0
      })

      expect(rule._limiter).to.equal(undefined)
      expect(rule.maxPerSecond).to.equal(undefined)
    })

    it('should create limiter with finite maxPerSecond', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0,
        maxPerSecond: 123
      })

      expect(rule._limiter).to.not.equal(undefined)
      expect(rule).to.have.property('maxPerSecond', 123)
    })

    it('should not sample spans past the rate limit', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0,
        maxPerSecond: 1
      })

      const spanContext = new SpanContext({ traceId: id('2986627970102095326', 10) })

      expect(rule.sample(spanContext)).to.equal(true)
      expect(rule.sample(spanContext)).to.equal(false)
    })

    it('should allow unlimited rate limits', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0
      })

      for (let i = 0; i < 1e3; i++) {
        expect(rule.sample(new SpanContext({ traceId: id() }))).to.equal(true)
      }
    })

    it('should sample if enough time has elapsed', () => {
      rule = new SamplingRule({
        service: 'test',
        name: 'operation',
        sampleRate: 1.0,
        maxPerSecond: 1
      })

      const clock = sinon.useFakeTimers({ now: new Date(), toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      expect(rule.sample(new SpanContext({ traceId: id() }))).to.equal(true)
      expect(rule.sample(new SpanContext({ traceId: id() }))).to.equal(false)
      clock.tick(1000)
      expect(rule.sample(new SpanContext({ traceId: id() }))).to.equal(true)
    })
  })
})

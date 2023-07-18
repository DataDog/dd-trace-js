'use strict'

require('./setup/tap')

const { expect } = require('chai')
const id = require('../src/id')

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
    'renamed_operation'
  ]

  const ids = [
    id('0234567812345671'),
    id('0234567812345672'),
    id('0234567812345673'),
    id('0234567812345674'),
    id('0234567812345675'),
    id('0234567812345676'),
    id('0234567812345677')
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

describe('span sampler', () => {
  let spans
  let spanContexts
  let SpanSampler
  let sampler

  beforeEach(() => {
    const info = createDummySpans()
    spans = info.spans
    spanContexts = info.spanContexts

    spanContexts[0]._trace.started.push(...spans)

    SpanSampler = require('../src/span_sampler')
  })

  describe('without drop', () => {
    beforeEach(() => {
      spanContexts[0]._sampling.priority = 2 // user keep
    })

    afterEach(() => {
      delete spanContexts[0]._sampling.priority
    })

    it('should not sample anything when trace is kept', done => {
      sampler = new SpanSampler({})
      try {
        const ingested = sampler.sample(spanContexts[0])
        expect(ingested).to.be.undefined
        done()
      } catch (err) { done(err) }
    })
  })

  describe('rules match properly', () => {
    it('should properly sample a single span', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 5
          }
        ]
      })

      sampler.sample(spanContexts[0])
      expect(spans[0].context()._spanSampling).to.eql({
        sampleRate: 1.0,
        maxPerSecond: 5
      })
      expect(spans[1].context()._spanSampling).to.be.undefined
      expect(spans[2].context()._spanSampling).to.be.undefined
      expect(spans[3].context()._spanSampling).to.be.undefined
      expect(spans[4].context()._spanSampling).to.be.undefined
      expect(spans[5].context()._spanSampling).to.be.undefined
      expect(spans[6].context()._spanSampling).to.be.undefined
      expect(spans[7].context()._spanSampling).to.be.undefined
      expect(spans[8].context()._spanSampling).to.be.undefined
    })

    it('should consider missing service as match-all for service name', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            name: 'sub_second_operation_*',
            sampleRate: 1.0,
            maxPerSecond: 5
          }
        ]
      })

      const spanSampling = {
        sampleRate: 1.0,
        maxPerSecond: 5
      }
      sampler.sample(spanContexts[0])
      expect(spans[0].context()._spanSampling).to.be.undefined
      expect(spans[1].context()._spanSampling).to.be.undefined
      expect(spans[2].context()._spanSampling).to.be.undefined
      // Only 3 and 4 should match because of the name pattern
      expect(spans[3].context()._spanSampling).to.eql(spanSampling)
      expect(spans[4].context()._spanSampling).to.eql(spanSampling)
      expect(spans[5].context()._spanSampling).to.be.undefined
      expect(spans[6].context()._spanSampling).to.be.undefined
      expect(spans[7].context()._spanSampling).to.be.undefined
      expect(spans[8].context()._spanSampling).to.be.undefined
    })

    it('should consider missing name as match-all for span name', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            sampleRate: 1.0,
            maxPerSecond: 10
          }
        ]
      })

      const spanSampling = {
        sampleRate: 1.0,
        maxPerSecond: 10
      }
      sampler.sample(spanContexts[0])
      expect(spans[0].context()._spanSampling).to.eql(spanSampling)
      expect(spans[1].context()._spanSampling).to.eql(spanSampling)
      expect(spans[2].context()._spanSampling).to.eql(spanSampling)
      expect(spans[3].context()._spanSampling).to.eql(spanSampling)
      expect(spans[4].context()._spanSampling).to.eql(spanSampling)
      expect(spans[5].context()._spanSampling).to.eql(spanSampling)
      expect(spans[8].context()._spanSampling).to.eql(spanSampling)
      // Should not match because of different service name
      expect(spans[6].context()._spanSampling).to.be.undefined
      expect(spans[7].context()._spanSampling).to.be.undefined
    })

    it('should stop at first rule match', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 5
          },
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 10
          }
        ]
      })

      sampler.sample(spanContexts[0])
      expect(spans[0].context()._spanSampling).to.eql({
        sampleRate: 1.0,
        maxPerSecond: 5
      })
      expect(spans[1].context()._spanSampling).to.be.undefined
      expect(spans[2].context()._spanSampling).to.be.undefined
      expect(spans[3].context()._spanSampling).to.be.undefined
      expect(spans[4].context()._spanSampling).to.be.undefined
      expect(spans[5].context()._spanSampling).to.be.undefined
      expect(spans[6].context()._spanSampling).to.be.undefined
      expect(spans[7].context()._spanSampling).to.be.undefined
      expect(spans[8].context()._spanSampling).to.be.undefined
    })

    it('should use span service name tags where present', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'span-service',
            sampleRate: 1.0,
            maxPerSecond: 5
          }
        ]
      })

      const spanSampling = {
        sampleRate: 1.0,
        maxPerSecond: 5
      }
      sampler.sample(spanContexts[0])
      expect(spans[0].context()._spanSampling).to.be.undefined
      expect(spans[1].context()._spanSampling).to.be.undefined
      expect(spans[2].context()._spanSampling).to.be.undefined
      expect(spans[3].context()._spanSampling).to.be.undefined
      expect(spans[4].context()._spanSampling).to.be.undefined
      expect(spans[5].context()._spanSampling).to.be.undefined
      expect(spans[6].context()._spanSampling).to.eql(spanSampling)
      expect(spans[7].context()._spanSampling).to.eql(spanSampling)
      expect(spans[8].context()._spanSampling).to.be.undefined
    })

    it('should properly sample multiple single spans with one rule', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: '*_2',
            sampleRate: 1.0,
            maxPerSecond: 5
          }
        ]
      })

      const spanSampling = {
        sampleRate: 1.0,
        maxPerSecond: 5
      }
      sampler.sample(spanContexts[0])
      expect(spans[1].context()._spanSampling).to.be.undefined
      expect(spans[2].context()._spanSampling).to.be.undefined
      expect(spans[3].context()._spanSampling).to.be.undefined
      expect(spans[4].context()._spanSampling).to.eql(spanSampling)
      expect(spans[5].context()._spanSampling).to.eql(spanSampling)
      expect(spans[6].context()._spanSampling).to.be.undefined
      expect(spans[7].context()._spanSampling).to.be.undefined
      expect(spans[8].context()._spanSampling).to.be.undefined
    })

    it('should properly sample mutiple single spans with multiple rules', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 5
          },
          {
            service: 'test',
            name: '*_second*',
            sampleRate: 1.0,
            maxPerSecond: 10
          }
        ]
      })

      sampler.sample(spanContexts[0])
      expect(spans[0].context()._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 5
      })
      expect(spans[3].context()._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10
      })
      expect(spans[4].context()._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10
      })
      expect(spans[5].context()._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10
      })
    })

    it('should properly sample renamed spans', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'renamed',
            sampleRate: 1.0,
            maxPerSecond: 1
          }
        ]
      })

      sampler.sample(spanContexts[0])
      expect(spans[0].context()._spanSampling).to.be.undefined
      expect(spans[1].context()._spanSampling).to.be.undefined
      expect(spans[2].context()._spanSampling).to.be.undefined
      expect(spans[3].context()._spanSampling).to.be.undefined
      expect(spans[4].context()._spanSampling).to.be.undefined
      expect(spans[5].context()._spanSampling).to.be.undefined
      expect(spans[6].context()._spanSampling).to.be.undefined
      expect(spans[7].context()._spanSampling).to.be.undefined
      expect(spans[8].context()._spanSampling).to.eql({
        sampleRate: 1.0,
        maxPerSecond: 1
      })
    })
  })

  describe('sampleRate', () => {
    beforeEach(() => {
      sinon.stub(Math, 'random')
    })

    afterEach(() => {
      Math.random.restore()
    })

    it('should sample a matched span on allowed sample rate', () => {
      Math.random.returns(0.5)
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 1
          }
        ]
      })

      sampler.sample(spanContexts[0])
      expect(spans[0].context()).to.haveOwnProperty('_spanSampling')
    })

    it('should not sample a matched span on non-allowed sample rate', () => {
      Math.random.returns(0.5)
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 0.3,
            maxPerSecond: 1
          }
        ]
      })

      sampler.sample(spanContexts[0])
      for (const span of spans) {
        expect(span.context()).to.not.haveOwnProperty('_spanSampling')
      }
    })

    it('should selectively sample based on sample rates', () => {
      Math.random.returns(0.5)
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 0.3,
            maxPerSecond: 1
          },
          {
            service: 'test',
            name: 'second_operation',
            sampleRate: 1.0,
            maxPerSecond: 1
          }
        ]
      })

      sampler.sample(spanContexts[0])
      expect(spans[2].context()).to.haveOwnProperty('_spanSampling')
      expect(spans[0].context()).to.not.haveOwnProperty('_spanSampling')
    })
  })

  describe('maxPerSecond', () => {
    it('should not create limiter without finite maxPerSecond', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0
          }
        ]
      })

      const rule = sampler._rules[0]
      expect(rule._limiter).to.equal(undefined)
      expect(rule.maxPerSecond).to.equal(undefined)
    })

    it('should create limiter with finite maxPerSecond', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 123
          }
        ]
      })

      const rule = sampler._rules[0]
      expect(rule._limiter).to.not.equal(undefined)
      expect(rule).to.have.property('maxPerSecond', 123)
    })

    it('should not sample spans past the rate limit', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 1
          }
        ]
      })

      sampler.sample(spanContexts[0])
      expect(spans[0].context()).to.haveOwnProperty('_spanSampling')
      delete spans[0].context()._spanSampling

      // with how quickly these tests execute, the limiter should not allow the
      // next call to sample any spans
      sampler.sample(spanContexts[0])
      expect(spans[0].context()).to.not.haveOwnProperty('_spanSampling')
    })

    it('should map different rules to different rate limiters', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 1
          },
          {
            service: 'test',
            name: 'sub_operation',
            sampleRate: 1.0,
            maxPerSecond: 2
          }
        ]
      })

      sampler.sample(spanContexts[0])
      expect(spans[0].context()).to.haveOwnProperty('_spanSampling')
      expect(spans[1].context()).to.haveOwnProperty('_spanSampling')
      delete spans[0].context()._spanSampling
      delete spans[1].context()._spanSampling

      // with how quickly these tests execute, the limiter should not allow the
      // next call to sample any spans
      sampler.sample(spanContexts[0])
      expect(spans[0].context()).to.not.haveOwnProperty('_spanSampling')
      expect(spans[1].context()).to.haveOwnProperty('_spanSampling')
    })

    it('should map limit by all spans matching pattern', () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'sub_second_operation_*',
            sampleRate: 1.0,
            maxPerSecond: 3
          }
        ]
      })

      // First time around both should have spanSampling to prove match
      sampler.sample(spanContexts[0])
      expect(spans[3].context()).to.haveOwnProperty('_spanSampling')
      expect(spans[4].context()).to.haveOwnProperty('_spanSampling')
      delete spans[3].context()._spanSampling
      delete spans[4].context()._spanSampling

      // Second time around only first should have spanSampling to prove limits
      sampler.sample(spanContexts[0])
      expect(spans[3].context()).to.haveOwnProperty('_spanSampling')
      expect(spans[4].context()).to.not.haveOwnProperty('_spanSampling')
    })

    it('should allow unlimited rate limits', async () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0
          }
        ]
      })

      const interval = setInterval(() => {
        sampler.sample(spanContexts[0])
        expect(spans[0].context()).to.haveOwnProperty('_spanSampling')
        delete spans[0].context()._spanSampling
      }, 1)

      await new Promise(resolve => {
        setTimeout(resolve, 1000)
      })

      clearInterval(interval)
    })

    it('should sample if enough time has elapsed', async () => {
      sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 1
          }
        ]
      })

      await new Promise(resolve => {
        sampler.sample(spanContexts[0])
        const before = spans[0].context()._spanSampling
        delete spans[0].context()._spanSampling

        setTimeout(() => {
          sampler.sample(spanContexts[0])
          const after = spans[0].context()._spanSampling
          delete spans[0].context()._spanSampling

          expect(before).to.eql(after)
          resolve()
        }, 1000)
      })
    })
  })
})

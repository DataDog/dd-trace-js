'use strict'

const { expect } = require('chai')
const id = require('../src/id')

function createDummySpans () {
  const operations = [
    'operation',
    'sub_operation',
    'second_operation',
    'sub_second_operation_1',
    'sub_second_operation_2',
    'sub_sub_second_operation_2'
  ]

  const ids = [
    id('0234567812345671'),
    id('0234567812345672'),
    id('0234567812345673'),
    id('0234567812345674'),
    id('0234567812345675'),
    id('0234567812345676')
  ]

  const spans = []
  const spanContexts = []

  operations.forEach((operation, idx) => {
    const id = ids[idx]
    const spanContext = {
      _spanId: id,
      _sampling: {},
      _trace: {
        started: []
      },
      _name: operation
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
  })

  return { spans, spanContexts }
}

describe('span ingestor', () => {
  let spans
  let spanContexts
  let SpanIngestor
  let ingestor

  beforeEach(() => {
    const info = createDummySpans()
    spans = info.spans
    spanContexts = info.spanContexts

    spanContexts[0]._trace.started.push(...spans)

    SpanIngestor = require('../src/span_ingestor')
  })

  describe('without drop', () => {
    beforeEach(() => {
      spanContexts[0]._sampling.priority = 2 // user keep
    })

    afterEach(() => {
      delete spanContexts[0]._sampling.priority
    })

    it('should not ingest anything when trace is kept', done => {
      ingestor = new SpanIngestor({})
      try {
        const ingested = ingestor.ingest(spanContexts[0])
        expect(ingested).to.be.undefined
        done()
      } catch (err) { done(err) }
    })
  })

  describe('rules match properly', () => {
    it('should properly ingest a single span', () => {
      ingestor = new SpanIngestor({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 5
          }
        ]
      })

      ingestor.ingest(spanContexts[0])
      expect(spans[0].context()._sampling.spanSampling).to.eql({
        sampleRate: 1.0,
        maxPerSecond: 5
      })
    })

    it('should properly ingest multiple single spans with one rule', () => {
      ingestor = new SpanIngestor({
        spanSamplingRules: [
          {
            service: 'test',
            name: '*_2',
            sampleRate: 1.0,
            maxPerSecond: 5
          }
        ]
      })

      ingestor.ingest(spanContexts[0])
      expect(spans[4].context()._sampling.spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 5
      })
      expect(spans[5].context()._sampling.spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 5
      })
    })

    it('should properly ingest mutiple single spans with multiple rules', () => {
      ingestor = new SpanIngestor({
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

      ingestor.ingest(spanContexts[0])
      expect(spans[0].context()._sampling.spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 5
      })
      expect(spans[3].context()._sampling.spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10
      })
      expect(spans[4].context()._sampling.spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10
      })
      expect(spans[5].context()._sampling.spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10
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

    it('should ingest a matched span on allowed sample rate', () => {
      Math.random.returns(0.5)
      ingestor = new SpanIngestor({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 1
          }
        ]
      })

      ingestor.ingest(spanContexts[0])
      expect(spans[0].context()._sampling).to.haveOwnProperty('spanSampling')
    })

    it('should not ingest a matched span on non-allowed sample rate', () => {
      Math.random.returns(0.5)
      ingestor = new SpanIngestor({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 0.3,
            maxPerSecond: 1
          }
        ]
      })

      ingestor.ingest(spanContexts[0])
      for (const span of spans) {
        expect(span.context()._sampling).to.not.haveOwnProperty('spanSampling')
      }
    })

    it('should selectively ingest based on sample rates', () => {
      Math.random.returns(0.5)
      ingestor = new SpanIngestor({
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

      ingestor.ingest(spanContexts[0])
      expect(spans[2].context()._sampling).to.haveOwnProperty('spanSampling')
      expect(spans[0].context()._sampling).to.not.haveOwnProperty('spanSampling')
    })
  })

  describe('maxPerSecond', () => {
    it('should not ingest spans past the rate limit', () => {
      ingestor = new SpanIngestor({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 1
          }
        ]
      })

      ingestor.ingest(spanContexts[0])
      expect(spans[0].context()._sampling).to.haveOwnProperty('spanSampling')
      delete spans[0].context()._sampling.spanSampling

      // with how quickly these tests execute, the limiter should not allow the
      // next call to ingest any spans
      ingestor.ingest(spanContexts[0])
      expect(spans[0].context()._sampling).to.not.haveOwnProperty('spanSampling')
    })

    it('should map different rules to different rate limiters', () => {
      ingestor = new SpanIngestor({
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

      ingestor.ingest(spanContexts[0])
      expect(spans[0].context()._sampling).to.haveOwnProperty('spanSampling')
      expect(spans[1].context()._sampling).to.haveOwnProperty('spanSampling')
      delete spans[0].context()._sampling.spanSampling
      delete spans[1].context()._sampling.spanSampling

      // with how quickly these tests execute, the limiter should not allow the
      // next call to ingest any spans
      ingestor.ingest(spanContexts[0])
      expect(spans[0].context()._sampling).to.not.haveOwnProperty('spanSampling')
      expect(spans[1].context()._sampling).to.haveOwnProperty('spanSampling')
    })

    it('should allow unlimited rate limits', async () => {
      ingestor = new SpanIngestor({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0
          }
        ]
      })

      const interval = setInterval(() => {
        ingestor.ingest(spanContexts[0])
        expect(spans[0].context()._sampling).to.haveOwnProperty('spanSampling')
        delete spans[0].context()._sampling.spanSampling
      }, 1)

      await new Promise(resolve => {
        setTimeout(resolve, 1000)
      })

      clearInterval(interval)
    })

    it('should ingest if enough time has elapsed', async () => {
      ingestor = new SpanIngestor({
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
        ingestor.ingest(spanContexts[0])
        const before = spans[0].context()._sampling.spanSampling
        delete spans[0].context()._sampling.spanSampling

        setTimeout(() => {
          ingestor.ingest(spanContexts[0])
          const after = spans[0].context()._sampling.spanSampling
          delete spans[0].context()._sampling.spanSampling

          expect(before).to.eql(after)
          resolve()
        }, 1000)
      })
    })
  })
})

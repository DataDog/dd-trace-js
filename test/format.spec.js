'use strict'

const Int64BE = require('int64-buffer').Int64BE
const constants = require('../src/constants')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY

const id = new Int64BE(0x02345678, 0x12345678)

describe('format', () => {
  let format
  let span
  let tracer
  let trace
  let spanContext

  beforeEach(() => {
    tracer = {
      _service: 'service'
    }

    spanContext = {
      traceId: id,
      spanId: id,
      parentId: id,
      tags: {},
      metrics: {},
      sampling: {}
    }

    span = {
      tracer: sinon.stub().returns(tracer),
      context: sinon.stub().returns(spanContext),
      _operationName: 'operation',
      _startTime: 1500000000000.123456,
      _duration: 100
    }

    format = require('../src/format')
  })

  describe('format', () => {
    it('should convert a span to the correct trace format', () => {
      trace = format(span)

      expect(trace.trace_id).to.equal(span.context().traceId)
      expect(trace.span_id).to.equal(span.context().spanId)
      expect(trace.parent_id).to.equal(span.context().parentId)
      expect(trace.name).to.equal(span._operationName)
      expect(trace.resource).to.equal(span._operationName)
      expect(trace.service).to.equal(span.tracer()._service)
      expect(trace.error).to.equal(0)
      expect(trace.start).to.be.instanceof(Int64BE)
      expect(trace.start.toNumber()).to.equal(span._startTime * 1e6)
      expect(trace.duration).to.be.instanceof(Int64BE)
      expect(trace.duration.toNumber()).to.equal(span._duration * 1e6)
    })

    it('should extract Datadog specific tags', () => {
      spanContext.tags['service.name'] = 'service'
      spanContext.tags['span.type'] = 'type'
      spanContext.tags['resource.name'] = 'resource'

      trace = format(span)

      expect(trace.service).to.equal('service')
      expect(trace.type).to.equal('type')
      expect(trace.resource).to.equal('resource')
    })

    it('should only extract tags that are not Datadog specific to meta', () => {
      spanContext.tags['service.name'] = 'service'
      spanContext.tags['span.type'] = 'type'
      spanContext.tags['resource.name'] = 'resource'
      spanContext.tags['foo.bar'] = 'foobar'

      trace = format(span)

      expect(trace.meta['service.name']).to.be.undefined
      expect(trace.meta['span.type']).to.be.undefined
      expect(trace.meta['resource.name']).to.be.undefined
      expect(trace.meta['foo.bar']).to.equal('foobar')
    })

    it('should extract metrics', () => {
      spanContext.metrics = { metric: 50 }

      trace = format(span)

      expect(trace.metrics).to.have.property('metric', 50)
    })

    it('should ignore metrics with invalid values', () => {
      spanContext.metrics = { metric: 'test' }

      trace = format(span)

      expect(trace.metrics).to.not.have.property('metric')
    })

    it('should extract errors', () => {
      span._error = new Error('boom')

      trace = format(span)

      expect(trace.meta['error.msg']).to.equal('boom')
      expect(trace.meta['error.type']).to.equal('Error')
      expect(trace.meta['error.stack']).to.equal(span._error.stack)
    })

    describe('when there is an `error` tag ', () => {
      it('should set the error flag when error tag is true', () => {
        spanContext.tags['error'] = true

        trace = format(span)

        expect(trace.error).to.equal(1)
      })

      it('should not set the error flag when error is false', () => {
        spanContext.tags['error'] = false

        trace = format(span)

        expect(trace.error).to.equal(0)
      })

      it('should not extract error to meta', () => {
        spanContext.tags['error'] = true

        trace = format(span)

        expect(trace.meta['error']).to.be.undefined
      })
    })

    it('should set the error flag when there is an error-related tag', () => {
      spanContext.tags['error.type'] = 'Error'
      spanContext.tags['error.msg'] = 'boom'
      spanContext.tags['error.stack'] = ''

      trace = format(span)

      expect(trace.error).to.equal(1)
    })

    it('should sanitize the input', () => {
      tracer._service = null
      span._operationName = null
      spanContext.tags = {
        'foo.bar': null
      }
      span._startTime = NaN
      span._duration = NaN

      trace = format(span)

      expect(trace.name).to.equal('null')
      expect(trace.service).to.equal('null')
      expect(trace.resource).to.equal('null')
      expect(trace.meta['foo.bar']).to.equal('null')
      expect(trace.start).to.be.instanceof(Int64BE)
      expect(trace.duration).to.be.instanceof(Int64BE)
    })

    it('should include the sampling priority', () => {
      spanContext.sampling.priority = 0
      trace = format(span)
      expect(trace.metrics[SAMPLING_PRIORITY_KEY]).to.equal(0)
    })
  })
})

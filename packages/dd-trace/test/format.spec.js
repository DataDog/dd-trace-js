'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')

require('./setup/tap')

const constants = require('../src/constants')
const tags = require('../../../ext/tags')
const id = require('../src/id')
const { getExtraServices } = require('../src/service-naming/extra-services')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY
const MEASURED = tags.MEASURED
const ORIGIN_KEY = constants.ORIGIN_KEY
const HOSTNAME_KEY = constants.HOSTNAME_KEY
const SAMPLING_AGENT_DECISION = constants.SAMPLING_AGENT_DECISION
const SAMPLING_LIMIT_DECISION = constants.SAMPLING_LIMIT_DECISION
const SAMPLING_RULE_DECISION = constants.SAMPLING_RULE_DECISION
const SPAN_SAMPLING_MECHANISM = constants.SPAN_SAMPLING_MECHANISM
const SPAN_SAMPLING_RULE_RATE = constants.SPAN_SAMPLING_RULE_RATE
const SPAN_SAMPLING_MAX_PER_SECOND = constants.SPAN_SAMPLING_MAX_PER_SECOND
const SAMPLING_MECHANISM_SPAN = constants.SAMPLING_MECHANISM_SPAN
const PROCESS_ID = constants.PROCESS_ID
const ERROR_MESSAGE = constants.ERROR_MESSAGE
const ERROR_STACK = constants.ERROR_STACK
const ERROR_TYPE = constants.ERROR_TYPE

const spanId = id('0234567812345678')
const spanId2 = id('0254567812345678')
const spanId3 = id('0264567812345678')

describe('format', () => {
  let format
  let span
  let trace
  let spanContext
  let spanContext2
  let spanContext3
  let TraceState

  beforeEach(() => {
    TraceState = require('../src/opentracing/propagation/tracestate')
    spanContext = {
      _traceId: spanId,
      _spanId: spanId,
      _parentId: spanId,
      _tags: {},
      _metrics: {},
      _sampling: {},
      _trace: {
        started: [],
        tags: {}
      },
      _name: 'operation',
      toTraceId: sinon.stub().returns(spanId),
      toSpanId: sinon.stub().returns(spanId)
    }

    span = {
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      setTag: sinon.stub(),
      _startTime: 1500000000000.123,
      _duration: 100
    }

    spanContext._trace.started.push(span)

    spanContext2 = {
      ...spanContext,
      _traceId: spanId2,
      _spanId: spanId2,
      _parentId: spanId2,
      toTraceId: sinon.stub().returns(spanId2.toString(16)),
      toSpanId: sinon.stub().returns(spanId2.toString(16))
    }
    spanContext3 = {
      ...spanContext,
      _traceId: spanId3,
      _spanId: spanId3,
      _parentId: spanId3,
      toTraceId: sinon.stub().returns(spanId3.toString(16)),
      toSpanId: sinon.stub().returns(spanId3.toString(16))
    }

    format = require('../src/format')
  })

  describe('format', () => {
    it('should format span events', () => {
      span._events = [
        { name: 'Something went so wrong', startTime: 1 },
        {
          name: 'I can sing!!! acbdefggnmdfsdv k 2e2ev;!|=xxx',
          attributes: { emotion: 'happy', rating: 9.8, other: [1, 9.5, 1], idol: false },
          startTime: 1633023102
        }
      ]

      trace = format(span)
      const spanEvents = trace.span_events
      expect(spanEvents).to.deep.equal([{
        name: 'Something went so wrong',
        time_unix_nano: 1000000,
        attributes: undefined
      }, {
        name: 'I can sing!!! acbdefggnmdfsdv k 2e2ev;!|=xxx',
        time_unix_nano: 1633023102000000,
        attributes: { emotion: 'happy', rating: 9.8, other: [1, 9.5, 1], idol: false }
      }])
    })

    it('should convert a span to the correct trace format', () => {
      trace = format(span)

      expect(trace.trace_id.toString()).to.equal(span.context()._traceId.toString())
      expect(trace.span_id.toString()).to.equal(span.context()._spanId.toString())
      expect(trace.parent_id.toString()).to.equal(span.context()._parentId.toString())
      expect(trace.name).to.equal(span.context()._name)
      expect(trace.resource).to.equal(span.context()._name)
      expect(trace.error).to.equal(0)
      expect(trace.start).to.equal(span._startTime * 1e6)
      expect(trace.duration).to.equal(span._duration * 1e6)
    })

    it('should always set a parent ID', () => {
      span.context()._parentId = null

      trace = format(span)

      expect(trace.trace_id.toString()).to.equal(span.context()._traceId.toString())
      expect(trace.span_id.toString()).to.equal(span.context()._spanId.toString())
      expect(trace.parent_id.toString()).to.equal('0000000000000000')
      expect(trace.name).to.equal(span.context()._name)
      expect(trace.resource).to.equal(span.context()._name)
      expect(trace.error).to.equal(0)
      expect(trace.start).to.equal(span._startTime * 1e6)
      expect(trace.duration).to.equal(span._duration * 1e6)
    })

    describe('_dd.base_service', () => {
      it('should infer the tag when span service changes', () => {
        span.context()._tags['service.name'] = 'foo'

        trace = format(span)

        expect(span.setTag).to.have.been.calledWith('_dd.base_service', 'test')
      })

      it('should infer the tag when no changes occur', () => {
        span.context()._tags['service.name'] = 'test'

        trace = format(span)

        expect(span.setTag).to.not.have.been.called
      })

      it('should register extra service name', () => {
        span.context()._tags['service.name'] = 'foo'

        trace = format(span)

        expect(getExtraServices()).to.deep.equal(['foo'])
      })
    })

    it('should extract Datadog specific tags', () => {
      spanContext._tags['service.name'] = 'service'
      spanContext._tags['span.type'] = 'type'
      spanContext._tags['resource.name'] = 'resource'

      trace = format(span)

      expect(trace.service).to.equal('service')
      expect(trace.type).to.equal('type')
      expect(trace.resource).to.equal('resource')
    })

    it('should extract Datadog specific root tags', () => {
      spanContext._parentId = null
      spanContext._trace[SAMPLING_AGENT_DECISION] = 0.8
      spanContext._trace[SAMPLING_LIMIT_DECISION] = 0.2
      spanContext._trace[SAMPLING_RULE_DECISION] = 0.5

      trace = format(span)

      expect(trace.metrics).to.include({
        [SAMPLING_AGENT_DECISION]: 0.8,
        [SAMPLING_LIMIT_DECISION]: 0.2,
        [SAMPLING_RULE_DECISION]: 0.5
      })
    })

    it('should not extract Datadog specific root tags from non-root spans', () => {
      spanContext._trace[SAMPLING_AGENT_DECISION] = 0.8
      spanContext._trace[SAMPLING_LIMIT_DECISION] = 0.2
      spanContext._trace[SAMPLING_RULE_DECISION] = 0.5

      trace = format(span)

      expect(trace.metrics).to.not.have.keys(
        SAMPLING_AGENT_DECISION,
        SAMPLING_LIMIT_DECISION,
        SAMPLING_RULE_DECISION
      )
    })

    it('should always add single span ingestion tags from options if present', () => {
      spanContext._spanSampling = {
        maxPerSecond: 5,
        sampleRate: 1.0
      }
      trace = format(span)

      expect(trace.metrics).to.include({
        [SPAN_SAMPLING_MECHANISM]: SAMPLING_MECHANISM_SPAN,
        [SPAN_SAMPLING_MAX_PER_SECOND]: 5,
        [SPAN_SAMPLING_RULE_RATE]: 1.0
      })
    })

    it('should not add single span ingestion tags if options not present', () => {
      trace = format(span)

      expect(trace.metrics).to.not.have.keys(
        SPAN_SAMPLING_MECHANISM,
        SPAN_SAMPLING_MAX_PER_SECOND,
        SPAN_SAMPLING_RULE_RATE
      )
    })

    it('should format span links', () => {
      span._links = [
        {
          context: spanContext2
        },
        {
          context: spanContext3
        }
      ]

      trace = format(span)
      const spanLinks = JSON.parse(trace.meta['_dd.span_links'])

      expect(spanLinks).to.deep.equal([{
        trace_id: spanId2.toString(16),
        span_id: spanId2.toString(16)
      }, {
        trace_id: spanId3.toString(16),
        span_id: spanId3.toString(16)
      }])
    })

    it('creates a span link', () => {
      const ts = TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')
      const traceIdHigh = '0000000000000010'
      spanContext2._tracestate = ts
      spanContext2._trace = {
        started: [],
        finished: [],
        origin: 'synthetics',
        tags: {
          '_dd.p.tid': traceIdHigh
        }
      }

      spanContext2._sampling.priority = 0
      const link = {
        context: spanContext2,
        attributes: { foo: 'bar' }
      }
      span._links = [link]

      trace = format(span)
      const spanLinks = JSON.parse(trace.meta['_dd.span_links'])

      expect(spanLinks).to.deep.equal([{
        trace_id: spanId2.toString(16),
        span_id: spanId2.toString(16),
        attributes: { foo: 'bar' },
        tracestate: ts.toString(),
        flags: 0
      }])
    })

    it('should extract trace chunk tags', () => {
      spanContext._trace.tags = {
        chunk: 'test',
        count: 1
      }

      trace = format(span)

      expect(trace.meta).to.include({
        chunk: 'test'
      })

      expect(trace.metrics).to.include({
        count: 1
      })
    })

    it('should extract empty tags', () => {
      spanContext._trace.tags = {
        foo: '',
        count: 1
      }

      trace = format(span)

      expect(trace.meta).to.include({
        foo: ''
      })

      expect(trace.metrics).to.include({
        count: 1
      })
    })

    it('should discard user-defined tags with name HOSTNAME_KEY by default', () => {
      spanContext._tags[HOSTNAME_KEY] = 'some_hostname'

      trace = format(span)

      expect(trace.meta[HOSTNAME_KEY]).to.be.undefined
    })

    it('should include the real hostname of the system if reportHostname is true', () => {
      spanContext._hostname = 'my_hostname'
      trace = format(span)

      expect(trace.meta[HOSTNAME_KEY]).to.equal('my_hostname')
    })

    it('should only extract tags that are not Datadog specific to meta', () => {
      spanContext._tags['service.name'] = 'service'
      spanContext._tags['span.type'] = 'type'
      spanContext._tags['resource.name'] = 'resource'
      spanContext._tags['foo.bar'] = 'foobar'

      trace = format(span)

      expect(trace.meta['service.name']).to.be.undefined
      expect(trace.meta['span.type']).to.be.undefined
      expect(trace.meta['resource.name']).to.be.undefined
      expect(trace.meta['foo.bar']).to.equal('foobar')
    })

    it('should extract numeric tags as metrics', () => {
      spanContext._tags = { metric: 50 }

      trace = format(span)

      expect(trace.metrics).to.have.property('metric', 50)
    })

    it('should extract boolean tags as metrics', () => {
      spanContext._tags = { yes: true, no: false }

      trace = format(span)

      expect(trace.metrics).to.have.property('yes', 1)
      expect(trace.metrics).to.have.property('no', 0)
    })

    it('should ignore metrics with invalid type', () => {
      spanContext._metrics = { metric: 'test' }

      trace = format(span)

      expect(trace.metrics).to.not.have.property('metric')
    })

    it('should ignore metrics that are not a number', () => {
      spanContext._metrics = { metric: NaN }

      trace = format(span)

      expect(trace.metrics).to.not.have.property('metric')
    })

    it('should extract errors', () => {
      const error = new Error('boom')

      spanContext._tags.error = error
      trace = format(span)

      expect(trace.meta[ERROR_MESSAGE]).to.equal(error.message)
      expect(trace.meta[ERROR_TYPE]).to.equal(error.name)
      expect(trace.meta[ERROR_STACK]).to.equal(error.stack)
    })

    it('should skip error properties without a value', () => {
      const error = new Error('boom')

      error.name = null
      error.stack = null
      spanContext._tags.error = error
      trace = format(span)

      expect(trace.meta[ERROR_MESSAGE]).to.equal(error.message)
      expect(trace.meta).to.not.have.property(ERROR_TYPE)
      expect(trace.meta).to.not.have.property(ERROR_STACK)
    })

    it('should extract the origin', () => {
      spanContext._trace.origin = 'synthetics'

      trace = format(span)

      expect(trace.meta[ORIGIN_KEY]).to.equal('synthetics')
    })

    it('should add the language tag for a basic span', () => {
      trace = format(span)

      expect(trace.meta.language).to.equal('javascript')
    })

    describe('when there is an `error` tag ', () => {
      it('should set the error flag when error tag is true', () => {
        spanContext._tags.error = true

        trace = format(span)

        expect(trace.error).to.equal(1)
      })

      it('should not set the error flag when error is false', () => {
        spanContext._tags.error = false

        trace = format(span)

        expect(trace.error).to.equal(0)
      })

      it('should not extract error to meta', () => {
        spanContext._tags.error = true

        trace = format(span)

        expect(trace.meta.error).to.be.undefined
      })
    })

    it('should set the error flag when there is an error-related tag without a set trace tag', () => {
      spanContext._tags[ERROR_TYPE] = 'Error'
      spanContext._tags[ERROR_MESSAGE] = 'boom'
      spanContext._tags[ERROR_STACK] = ''

      trace = format(span)

      expect(trace.error).to.equal(1)
    })

    it('should set the error flag when there is an error-related tag with should setTrace', () => {
      spanContext._tags[ERROR_TYPE] = 'Error'
      spanContext._tags[ERROR_MESSAGE] = 'boom'
      spanContext._tags[ERROR_STACK] = ''
      spanContext._tags.setTraceError = 1

      trace = format(span)

      expect(trace.error).to.equal(1)

      spanContext._tags[ERROR_TYPE] = 'foo'
      spanContext._tags[ERROR_MESSAGE] = 'foo'
      spanContext._tags[ERROR_STACK] = 'foo'

      expect(trace.error).to.equal(1)
    })

    it('should not set the error flag for internal spans with error tags', () => {
      spanContext._tags[ERROR_TYPE] = 'Error'
      spanContext._tags[ERROR_MESSAGE] = 'boom'
      spanContext._tags[ERROR_STACK] = ''
      spanContext._name = 'fs.operation'

      trace = format(span)

      expect(trace.error).to.equal(0)
    })

    it('should not set the error flag for internal spans with error tag', () => {
      spanContext._tags.error = new Error('boom')
      spanContext._name = 'fs.operation'

      trace = format(span)

      expect(trace.error).to.equal(0)
    })

    it('should sanitize the input', () => {
      spanContext._name = null
      spanContext._tags = {
        'foo.bar': null,
        'baz.qux': undefined
      }
      span._startTime = NaN
      span._duration = NaN

      trace = format(span)

      expect(trace.name).to.equal('null')
      expect(trace.resource).to.equal('null')
      expect(trace.meta).to.not.have.property('foo.bar')
      expect(trace.meta).to.not.have.property('baz.qux')
      expect(trace.start).to.be.a('number')
      expect(trace.duration).to.be.a('number')
    })

    it('should include the sampling priority', () => {
      spanContext._sampling.priority = 0
      trace = format(span)
      expect(trace.metrics[SAMPLING_PRIORITY_KEY]).to.equal(0)
    })

    it('should support only the first level of depth for objects', () => {
      const tag = {
        A: {
          B: {},
          num: '2'
        },
        num: '1'
      }

      spanContext._tags.nested = tag
      trace = format(span)

      expect(trace.meta['nested.num']).to.equal('1')
      expect(trace.meta['nested.A']).to.be.undefined
      expect(trace.meta['nested.A.B']).to.be.undefined
      expect(trace.meta['nested.A.num']).to.be.undefined
    })

    it('should accept a boolean for measured', () => {
      spanContext._tags[MEASURED] = true
      trace = format(span)
      expect(trace.metrics[MEASURED]).to.equal(1)
    })

    it('should accept a numeric value for measured', () => {
      spanContext._tags[MEASURED] = 0
      trace = format(span)
      expect(trace.metrics[MEASURED]).to.equal(0)
    })

    it('should accept undefined for measured', () => {
      spanContext._tags[MEASURED] = undefined
      trace = format(span)
      expect(trace.metrics[MEASURED]).to.equal(1)
    })

    it('should not measure internal spans', () => {
      spanContext._tags['span.kind'] = 'internal'
      trace = format(span)
      expect(trace.metrics).to.not.have.property(MEASURED)
    })

    it('should not measure unknown spans', () => {
      trace = format(span)
      expect(trace.metrics).to.not.have.property(MEASURED)
    })

    it('should measure non-internal spans', () => {
      spanContext._tags['span.kind'] = 'server'
      trace = format(span)
      expect(trace.metrics[MEASURED]).to.equal(1)
    })

    it('should not override explicit measure decision', () => {
      spanContext._tags[MEASURED] = 0
      spanContext._tags['span.kind'] = 'server'
      trace = format(span)
      expect(trace.metrics[MEASURED]).to.equal(0)
    })

    it('should possess a process_id tag', () => {
      trace = format(span)
      expect(trace.metrics[PROCESS_ID]).to.equal(process.pid)
    })

    it('should not crash on prototype-free tags objects when nesting', () => {
      const tags = Object.create(null)
      tags.nested = { foo: 'bar' }
      spanContext._tags.nested = tags

      format(span)
    })

    it('should capture analytics.event', () => {
      spanContext._tags['analytics.event'] = 1

      trace = format(span)

      expect(trace.metrics).to.have.property('_dd1.sr.eausr', 1)
    })
  })
})

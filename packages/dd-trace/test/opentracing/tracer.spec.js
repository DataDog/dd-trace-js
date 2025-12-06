'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const opentracing = require('opentracing')
const proxyquire = require('proxyquire')

const os = require('node:os')

require('../setup/core')

const SpanContext = require('../../src/opentracing/span_context')
const formats = require('../../../../ext/formats')
const Reference = opentracing.Reference

describe('Tracer', () => {
  let Tracer
  let tracer
  let Span
  let span
  let PrioritySampler
  let prioritySampler
  let AgentExporter
  let SpanProcessor
  let processor
  let exporter
  let agentExporter
  let spanContext
  let fields
  let carrier
  let TextMapPropagator
  let HttpPropagator
  let BinaryPropagator
  let LogPropagator
  let propagator
  let config
  let log

  beforeEach(() => {
    fields = {}

    span = {
      addTags: sinon.stub().returns(span)
    }
    Span = sinon.stub().returns(span)

    prioritySampler = {
      sample: sinon.stub()
    }
    PrioritySampler = sinon.stub().returns(prioritySampler)

    agentExporter = {
      export: sinon.spy()
    }
    AgentExporter = sinon.stub().returns(agentExporter)

    processor = {
      process: sinon.spy()
    }
    SpanProcessor = sinon.stub().returns(processor)

    spanContext = {}
    carrier = {}

    TextMapPropagator = sinon.stub()
    HttpPropagator = sinon.stub()
    BinaryPropagator = sinon.stub()
    LogPropagator = sinon.stub()
    propagator = {
      inject: sinon.stub(),
      extract: sinon.stub()
    }

    config = {
      service: 'service',
      url: 'http://test:7777',
      flushInterval: 2000,
      sampleRate: 0.5,
      logger: 'logger',
      tags: {},
      debug: true,
      experimental: {}
    }

    log = {
      use: sinon.spy(),
      toggle: sinon.spy(),
      error: sinon.spy()
    }

    exporter = sinon.stub().returns(AgentExporter)

    Tracer = proxyquire('../../src/opentracing/tracer', {
      './span': Span,
      './span_context': SpanContext,
      '../priority_sampler': PrioritySampler,
      '../span_processor': SpanProcessor,
      './propagation/text_map': TextMapPropagator,
      './propagation/http': HttpPropagator,
      './propagation/binary': BinaryPropagator,
      './propagation/log': LogPropagator,
      '../log': log,
      '../exporter': exporter
    })
  })

  it('should support recording', () => {
    tracer = new Tracer(config)

    sinon.assert.called(AgentExporter)
    sinon.assert.calledWith(AgentExporter, config, prioritySampler)
    sinon.assert.calledWith(SpanProcessor, agentExporter, prioritySampler, config)
  })

  it('should allow to configure an alternative prioritySampler', () => {
    const sampler = {}
    tracer = new Tracer(config, sampler)

    sinon.assert.calledWith(AgentExporter, config, sampler)
    sinon.assert.calledWith(SpanProcessor, agentExporter, sampler, config)
  })

  describe('startSpan', () => {
    it('should start a span', () => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000

      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        tags: {
          'service.name': 'service'
        },
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: undefined
      }, true)

      sinon.assert.calledWith(span.addTags, {
        foo: 'bar'
      })

      assert.strictEqual(testSpan, span)
    })

    it('should start a span that is the child of a span', () => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_CHILD_OF, parent)
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWithMatch(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent
      })
    })

    it('should start a span that follows from a span', () => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent)
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWithMatch(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent
      })
    })

    it('should start a span with the system hostname if reportHostname is enabled', () => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000
      config.reportHostname = true
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        tags: {
          'service.name': 'service'
        },
        startTime: fields.startTime,
        hostname: os.hostname(),
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: undefined
      })

      assert.strictEqual(testSpan, span)
    })

    it('should ignore additional follow references', () => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent),
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, new SpanContext())
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWithMatch(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent
      })
    })

    it('should ignore unknown references', () => {
      const parent = new SpanContext()

      fields.references = [
        new Reference('test', parent)
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWithMatch(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null
      })
    })

    it('should merge default tracer tags with span tags', () => {
      config.tags = {
        foo: 'tracer',
        bar: 'tracer'
      }

      fields.tags = {
        bar: 'span',
        baz: 'span'
      }

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWith(span.addTags, config.tags)
      sinon.assert.calledWith(span.addTags, fields.tags)
    })

    it('If span is granted a service name that differs from the global service name' +
      'ensure spans `version` tag is undefined.', () => {
      config.tags = {
        foo: 'tracer',
        bar: 'tracer'
      }

      fields.tags = {
        bar: 'span',
        baz: 'span',
        service: 'new-service'

      }

      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(span.addTags, config.tags)
      sinon.assert.calledWith(span.addTags, { ...fields.tags, version: undefined })
      sinon.assert.calledWith(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        tags: {
          'service.name': 'new-service'
        },
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: undefined
      })
      assert.strictEqual(testSpan, span)
    })

    it('should start a span with the trace ID generation configuration', () => {
      config.traceId128BitGenerationEnabled = true
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        tags: {
          'service.name': 'service'
        },
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: true,
        integrationName: undefined,
        links: undefined
      })

      assert.strictEqual(testSpan, span)
    })

    it('should start a span with span links attached', () => {
      const context = new SpanContext()
      fields.links = [{ context }]
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(Span, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        tags: {
          'service.name': 'service'
        },
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: [{ context }]
      })

      assert.strictEqual(testSpan, span)
    })
  })

  describe('inject', () => {
    it('should support text map format', () => {
      TextMapPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_TEXT_MAP, carrier)

      sinon.assert.calledWith(TextMapPropagator, config)
      sinon.assert.calledWith(propagator.inject, spanContext, carrier)
    })

    it('should support http headers format', () => {
      HttpPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_HTTP_HEADERS, carrier)

      sinon.assert.calledWith(HttpPropagator, config)
      sinon.assert.calledWith(propagator.inject, spanContext, carrier)
    })

    it('should support binary format', () => {
      BinaryPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_BINARY, carrier)

      sinon.assert.calledWith(propagator.inject, spanContext, carrier)
    })

    it('should handle errors', () => {
      tracer = new Tracer(config)

      expect(() => tracer.inject({})).not.to.throw()
      sinon.assert.calledOnce(log.error)
    })

    it('should generate the sampling priority', () => {
      TextMapPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_TEXT_MAP, carrier)

      sinon.assert.calledWith(prioritySampler.sample, spanContext)
    })

    it('should not generate sampling priority for log injection', () => {
      LogPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, formats.LOG, carrier)

      sinon.assert.notCalled(prioritySampler.sample)
      sinon.assert.calledWith(propagator.inject, spanContext, carrier)
    })
  })

  describe('extract', () => {
    it('should support text map format', () => {
      TextMapPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_TEXT_MAP, carrier)

      assert.strictEqual(spanContext, 'spanContext')
    })

    it('should support http headers format', () => {
      HttpPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_HTTP_HEADERS, carrier)

      assert.strictEqual(spanContext, 'spanContext')
    })

    it('should support binary format', () => {
      BinaryPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_BINARY, carrier)

      assert.strictEqual(spanContext, 'spanContext')
    })

    it('should handle errors', () => {
      tracer = new Tracer(config)

      expect(() => tracer.extract()).not.to.throw()
    })
  })
})

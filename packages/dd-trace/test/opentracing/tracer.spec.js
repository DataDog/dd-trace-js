'use strict'

const t = require('tap')
require('../setup/core')

const opentracing = require('opentracing')
const os = require('os')
const SpanContext = require('../../src/opentracing/span_context')
const Reference = opentracing.Reference

t.test('Tracer', t => {
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
  let propagator
  let config
  let log

  t.beforeEach(() => {
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

    Tracer = proxyquire('../src/opentracing/tracer', {
      './span': Span,
      './span_context': SpanContext,
      '../priority_sampler': PrioritySampler,
      '../span_processor': SpanProcessor,
      './propagation/text_map': TextMapPropagator,
      './propagation/http': HttpPropagator,
      './propagation/binary': BinaryPropagator,
      '../log': log,
      '../exporter': exporter
    })
  })

  t.test('should support recording', t => {
    tracer = new Tracer(config)

    expect(AgentExporter).to.have.been.called
    expect(AgentExporter).to.have.been.calledWith(config, prioritySampler)
    expect(SpanProcessor).to.have.been.calledWith(agentExporter, prioritySampler, config)
    t.end()
  })

  t.test('should allow to configure an alternative prioritySampler', t => {
    const sampler = {}
    tracer = new Tracer(config, sampler)

    expect(AgentExporter).to.have.been.calledWith(config, sampler)
    expect(SpanProcessor).to.have.been.calledWith(agentExporter, sampler, config)
    t.end()
  })

  t.test('startSpan', t => {
    t.test('should start a span', t => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000

      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWith(tracer, processor, prioritySampler, {
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

      expect(span.addTags).to.have.been.calledWith({
        foo: 'bar'
      })

      expect(testSpan).to.equal(span)
      t.end()
    })

    t.test('should start a span that is the child of a span', t => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_CHILD_OF, parent)
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWithMatch(tracer, processor, prioritySampler, {
        operationName: 'name',
        parent
      })
      t.end()
    })

    t.test('should start a span that follows from a span', t => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent)
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWithMatch(tracer, processor, prioritySampler, {
        operationName: 'name',
        parent
      })
      t.end()
    })

    t.test('should start a span with the system hostname if reportHostname is enabled', t => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000
      config.reportHostname = true
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWith(tracer, processor, prioritySampler, {
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

      expect(testSpan).to.equal(span)
      t.end()
    })

    t.test('should ignore additional follow references', t => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent),
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, new SpanContext())
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWithMatch(tracer, processor, prioritySampler, {
        operationName: 'name',
        parent
      })
      t.end()
    })

    t.test('should ignore unknown references', t => {
      const parent = new SpanContext()

      fields.references = [
        new Reference('test', parent)
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWithMatch(tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null
      })
      t.end()
    })

    t.test('should merge default tracer tags with span tags', t => {
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

      expect(span.addTags).to.have.been.calledWith(config.tags)
      expect(span.addTags).to.have.been.calledWith(fields.tags)
      t.end()
    })

    t.test('If span is granted a service name that differs from the global service name' +
      'ensure spans `version` tag is undefined.', t => {
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

      expect(span.addTags).to.have.been.calledWith(config.tags)
      expect(span.addTags).to.have.been.calledWith({ ...fields.tags, version: undefined })
      expect(Span).to.have.been.calledWith(tracer, processor, prioritySampler, {
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
      expect(testSpan).to.equal(span)
      t.end()
    })

    t.test('should start a span with the trace ID generation configuration', t => {
      config.traceId128BitGenerationEnabled = true
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWith(tracer, processor, prioritySampler, {
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

      expect(testSpan).to.equal(span)
      t.end()
    })

    t.test('should start a span with span links attached', t => {
      const context = new SpanContext()
      fields.links = [{ context }]
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWith(tracer, processor, prioritySampler, {
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

      expect(testSpan).to.equal(span)
      t.end()
    })
    t.end()
  })

  t.test('inject', t => {
    t.test('should support text map format', t => {
      TextMapPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_TEXT_MAP, carrier)

      expect(TextMapPropagator).to.have.been.calledWith(config)
      expect(propagator.inject).to.have.been.calledWith(spanContext, carrier)
      t.end()
    })

    t.test('should support http headers format', t => {
      HttpPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_HTTP_HEADERS, carrier)

      expect(HttpPropagator).to.have.been.calledWith(config)
      expect(propagator.inject).to.have.been.calledWith(spanContext, carrier)
      t.end()
    })

    t.test('should support binary format', t => {
      BinaryPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_BINARY, carrier)

      expect(propagator.inject).to.have.been.calledWith(spanContext, carrier)
      t.end()
    })

    t.test('should handle errors', t => {
      tracer = new Tracer(config)

      expect(() => tracer.inject({})).not.to.throw()
      expect(log.error).to.have.been.calledOnce
      t.end()
    })

    t.test('should generate the sampling priority', t => {
      TextMapPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_TEXT_MAP, carrier)

      expect(prioritySampler.sample).to.have.been.calledWith(spanContext)
      t.end()
    })
    t.end()
  })

  t.test('extract', t => {
    t.test('should support text map format', t => {
      TextMapPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_TEXT_MAP, carrier)

      expect(spanContext).to.equal('spanContext')
      t.end()
    })

    t.test('should support http headers format', t => {
      HttpPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_HTTP_HEADERS, carrier)

      expect(spanContext).to.equal('spanContext')
      t.end()
    })

    t.test('should support binary format', t => {
      BinaryPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_BINARY, carrier)

      expect(spanContext).to.equal('spanContext')
      t.end()
    })

    t.test('should handle errors', t => {
      tracer = new Tracer(config)

      expect(() => tracer.extract()).not.to.throw()
      t.end()
    })
    t.end()
  })
  t.end()
})

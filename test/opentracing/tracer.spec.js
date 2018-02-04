'use strict'

const opentracing = require('opentracing')
const url = require('url')
const Reference = opentracing.Reference

describe('Tracer', () => {
  let Tracer
  let tracer
  let Span
  let span
  let Recorder
  let recorder
  let spanContext
  let fields
  let carrier
  let TextMapPropagator
  let HttpPropagator
  let BinaryPropagator
  let propagator
  let log

  beforeEach(() => {
    fields = {}

    span = {}
    Span = sinon.stub().returns(span)

    recorder = {
      init: sinon.spy(),
      record: sinon.spy()
    }
    Recorder = sinon.stub().returns(recorder)

    spanContext = {}
    carrier = {}

    TextMapPropagator = sinon.stub()
    HttpPropagator = sinon.stub()
    BinaryPropagator = sinon.stub()
    propagator = {
      inject: sinon.stub(),
      extract: sinon.stub()
    }

    log = {
      use: sinon.spy()
    }

    Tracer = proxyquire('../src/opentracing/tracer', {
      './span': Span,
      '../recorder': Recorder,
      './propagation/text_map': TextMapPropagator,
      './propagation/http': HttpPropagator,
      './propagation/binary': BinaryPropagator,
      '../log': log
    })
  })

  it('should support recording', () => {
    tracer = new Tracer({ service: 'service' })
    tracer._record('span')

    expect(Recorder).to.have.been.calledWith(sinon.match(url.parse('http://localhost:8126'), 2000, 1000))
    expect(recorder.init).to.have.been.called
    expect(recorder.record).to.have.been.calledWith('span')
  })

  it('should be configurable', () => {
    tracer = new Tracer({
      service: 'service',
      hostname: 'test',
      port: 7777,
      protocol: 'https',
      flushInterval: 1000,
      bufferSize: 5000,
      logger: 'logger'
    })

    expect(Recorder).to.have.been.calledWith(sinon.match(url.parse('https://test:7777')), 1000, 5000)
    expect(log.use).to.have.been.calledWith('logger')
  })

  describe('startSpan', () => {
    it('should start a span', () => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000

      tracer = new Tracer({ service: 'service' })
      const testSpan = tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWith(tracer, {
        operationName: 'name',
        parent: null,
        tags: fields.tags,
        startTime: fields.startTime
      })

      expect(testSpan).to.equal(span)
    })

    it('should start a span that is the child of a span', () => {
      const parent = {}

      fields.references = [
        new Reference(opentracing.REFERENCE_CHILD_OF, parent)
      ]

      tracer = new Tracer({ service: 'service' })
      tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWithMatch(tracer, {
        operationName: 'name',
        parent
      })
    })

    it('should start a span that follows from a span', () => {
      const parent = {}

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent)
      ]

      tracer = new Tracer({ service: 'service' })
      tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWithMatch(tracer, {
        operationName: 'name',
        parent
      })
    })

    it('should ignore additional follow references', () => {
      const parent = {}

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent),
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, {})
      ]

      tracer = new Tracer({ service: 'service' })
      tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWithMatch(tracer, {
        operationName: 'name',
        parent
      })
    })

    it('should ignore unknown references', () => {
      fields.references = [
        new Reference('test', {})
      ]

      tracer = new Tracer({ service: 'service' })
      tracer.startSpan('name', fields)

      expect(Span).to.have.been.calledWithMatch(tracer, {
        operationName: 'name',
        parent: null
      })
    })
  })

  describe('inject', () => {
    it('should support text map format', () => {
      TextMapPropagator.returns(propagator)

      tracer = new Tracer({ service: 'service' })
      tracer.inject(spanContext, opentracing.FORMAT_TEXT_MAP, carrier)

      expect(propagator.inject).to.have.been.calledWith(spanContext, carrier)
    })

    it('should support http headers format', () => {
      HttpPropagator.returns(propagator)

      tracer = new Tracer({ service: 'service' })
      tracer.inject(spanContext, opentracing.FORMAT_HTTP_HEADERS, carrier)

      expect(propagator.inject).to.have.been.calledWith(spanContext, carrier)
    })

    it('should support binary format', () => {
      BinaryPropagator.returns(propagator)

      tracer = new Tracer({ service: 'service' })
      tracer.inject(spanContext, opentracing.FORMAT_BINARY, carrier)

      expect(propagator.inject).to.have.been.calledWith(spanContext, carrier)
    })
  })

  describe('extract', () => {
    it('should support text map format', () => {
      TextMapPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer({ service: 'service' })
      const spanContext = tracer.extract(opentracing.FORMAT_TEXT_MAP, carrier)

      expect(spanContext).to.equal('spanContext')
    })

    it('should support http headers format', () => {
      HttpPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer({ service: 'service' })
      const spanContext = tracer.extract(opentracing.FORMAT_HTTP_HEADERS, carrier)

      expect(spanContext).to.equal('spanContext')
    })

    it('should support binary format', () => {
      BinaryPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer({ service: 'service' })
      const spanContext = tracer.extract(opentracing.FORMAT_BINARY, carrier)

      expect(spanContext).to.equal('spanContext')
    })
  })
})

'use strict'

const Span = require('../src/opentracing/span')
const SpanContext = require('../src/opentracing/span_context')
const Config = require('../src/config')
const platform = require('../src/platform')

describe('Tracer', () => {
  let Tracer
  let tracer
  let context
  let config
  let instrumenter
  let Instrumenter

  beforeEach(() => {
    config = new Config({ service: 'service' })
    context = platform.context(config)
    sinon.stub(context, 'bind')
    sinon.stub(context, 'bindEmitter')

    instrumenter = {
      use: sinon.spy(),
      patch: sinon.spy()
    }
    Instrumenter = sinon.stub().returns(instrumenter)

    Tracer = proxyquire('../src/tracer', {
      './instrumenter': Instrumenter
    })
  })

  afterEach(() => {
    context.bind.restore()
    context.bindEmitter.restore()
  })

  describe('trace', () => {
    it('should run the callback with the new span', done => {
      tracer = new Tracer(config)

      tracer.trace('name', current => {
        expect(current).to.be.instanceof(Span)
        done()
      })
    })

    it('should use the parent context', done => {
      tracer = new Tracer(config)

      tracer.trace('parent', parent => {
        tracer.trace('child', child => {
          expect(child.context()).to.have.property('parentId', parent.context().spanId)
          done()
        })
      })
    })

    it('should support explicitly creating a root span', done => {
      tracer = new Tracer(config)

      tracer.trace('parent', parent => {
        tracer.trace('child', { childOf: null }, child => {
          expect(child.context()).to.have.property('parentId', null)
          done()
        })
      })
    })

    it('should set default tags', done => {
      tracer = new Tracer(config)

      tracer.trace('name', current => {
        expect(current._tags).to.have.property('service.name', 'service')
        expect(current._tags).to.have.property('resource.name', 'name')
        expect(current._tags).to.not.have.property('span.type')
        done()
      })
    })

    it('should support service option', done => {
      tracer = new Tracer(config)

      tracer.trace('name', { service: 'test' }, current => {
        expect(current._tags).to.have.property('service.name', 'test')
        done()
      })
    })

    it('should support resource option', done => {
      tracer = new Tracer(config)

      tracer.trace('name', { resource: 'test' }, current => {
        expect(current._tags).to.have.property('resource.name', 'test')
        done()
      })
    })

    it('should support type option', done => {
      tracer = new Tracer(config)

      tracer.trace('name', { type: 'test' }, current => {
        expect(current._tags).to.have.property('span.type', 'test')
        done()
      })
    })

    it('should support custom tags', done => {
      const tags = {
        'foo': 'bar'
      }

      tracer = new Tracer(config)

      tracer.trace('name', { tags }, current => {
        expect(current._tags).to.have.property('foo', 'bar')
        done()
      })
    })

    it('should support a custom parent span', done => {
      const childOf = new SpanContext({
        traceId: 1234,
        spanId: 5678
      })

      tracer = new Tracer(config)

      tracer.trace('name', { childOf }, current => {
        expect(current.context().traceId).to.equal(childOf.traceId)
        expect(current.context().parentId).to.equal(childOf.spanId)
        done()
      })
    })
  })

  describe('currentSpan', () => {
    it('should return the current span', done => {
      tracer = new Tracer(config)

      tracer.trace('name', current => {
        expect(tracer.currentSpan()).to.equal(current)
        done()
      })
    })

    it('should return null when there is no current span', () => {
      tracer = new Tracer(config)

      expect(tracer.currentSpan()).to.be.null
    })
  })

  describe('bind', () => {
    it('should bind a function to the context', done => {
      const callback = () => {}

      tracer = new Tracer(config)

      tracer.trace('name', current => {
        tracer.bind(callback)
        expect(context.bind).to.have.been.calledWith(callback)
        done()
      })
    })
  })

  describe('bindEmitter', () => {
    it('should bind an emitter to the context', done => {
      const emitter = 'emitter'

      tracer = new Tracer(config)

      tracer.trace('name', current => {
        tracer.bindEmitter(emitter)
        expect(context.bindEmitter).to.have.been.calledWith(emitter)
        done()
      })
    })
  })
})

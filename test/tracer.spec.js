'use strict'

const Span = require('opentracing').Span
const Config = require('../src/config')

wrapIt()

describe('Tracer', () => {
  let Tracer
  let tracer
  let config
  let instrumenter
  let Instrumenter

  beforeEach(() => {
    config = new Config({ service: 'service' })

    instrumenter = {
      use: sinon.spy(),
      patch: sinon.spy()
    }
    Instrumenter = sinon.stub().returns(instrumenter)

    Tracer = proxyquire('../src/tracer', {
      './instrumenter': Instrumenter
    })

    tracer = new Tracer(config)
  })

  describe('trace', () => {
    it('should run the callback with a noop span', done => {
      tracer.trace('name', current => {
        expect(current).to.be.instanceof(Span)
        done()
      })
    })
  })

  describe('currentSpan', () => {
    it('should return the current span', done => {
      tracer.trace('name', current => {
        expect(tracer.currentSpan()).to.equal(current)
        done()
      })
    })

    it('should return a noop span', () => {
      expect(tracer.currentSpan()).to.not.be.null
    })
  })
})

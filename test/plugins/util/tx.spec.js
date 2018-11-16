'use strict'

describe('plugins/util/tx', () => {
  let tx
  let tracer
  let span

  beforeEach(() => {
    tracer = require('../../..').init({ plugins: false })
    span = tracer.startSpan('test')
    tx = require('../../../src/plugins/util/tx')

    sinon.spy(span, 'finish')
  })

  afterEach(() => {
    span.finish.restore()
  })

  describe('setHost', () => {
    it('should set the out.host and out.port tags', () => {
      tx.setHost(span, 'example.com', '1234')

      expect(span.context().tags).to.have.property('out.host', 'example.com')
      expect(span.context().tags).to.have.property('out.port', '1234')
    })
  })

  describe('wrap', () => {
    describe('with a callback', () => {
      it('should return a wrapper that finishes the span', () => {
        const callback = sinon.spy()
        const wrapper = tx.wrap(span, callback)

        wrapper(null, 'foo', 'bar')

        expect(callback).to.have.been.calledWith(null, 'foo', 'bar')
        expect(span.finish).to.have.been.called
      })

      it('should return a wrapper that sets error tags', () => {
        const callback = sinon.spy()
        const error = new Error('boom')
        const wrapper = tx.wrap(span, callback)

        wrapper(error)

        expect(span.context().tags).to.have.property('error.msg', error.message)
        expect(span.context().tags).to.have.property('error.type', error.name)
        expect(span.context().tags).to.have.property('error.stack', error.stack)
      })
    })

    describe('with a promise', () => {
      it('should finish the span when the promise is resolved', () => {
        const promise = Promise.resolve('value')

        tx.wrap(span, promise)

        return promise.then(value => {
          expect(value).to.equal('value')
          expect(span.finish).to.have.been.called
        })
      })

      it('should set the error tags when the promise is rejected', () => {
        const error = new Error('boom')
        const promise = Promise.reject(error)

        tx.wrap(span, promise)

        return promise.catch(err => {
          expect(err).to.equal(error)
          expect(span.context().tags).to.have.property('error.msg', error.message)
          expect(span.context().tags).to.have.property('error.type', error.name)
          expect(span.context().tags).to.have.property('error.stack', error.stack)
        })
      })
    })
  })
})

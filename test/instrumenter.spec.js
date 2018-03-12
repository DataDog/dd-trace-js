'use strict'

const proxyquire = require('proxyquire').noCallThru()

describe('Instrumenter', () => {
  let Instrumenter
  let instrumenter
  let integrations
  let tracer
  let requireDir
  let foo
  let bar

  beforeEach(() => {
    tracer = 'tracer'
    foo = 'foo'
    bar = 'bar'

    integrations = {
      foo: {
        name: 'foo',
        patch: sinon.spy(),
        unpatch: sinon.spy()
      },
      bar: {
        name: 'bar',
        patch: sinon.spy(),
        unpatch: sinon.spy()
      }
    }

    requireDir = sinon.stub()
    requireDir.withArgs('./plugins').returns(integrations)

    Instrumenter = proxyquire('../src/instrumenter', {
      'require-dir': requireDir,
      'foo': foo,
      'bar': bar
    })
  })

  describe('when enabled', () => {
    beforeEach(() => {
      instrumenter = new Instrumenter(tracer, { plugins: true })
    })

    describe('patch', () => {
      it('should patch all modules', () => {
        instrumenter.patch()

        expect(integrations.foo.patch).to.have.been.calledWith(foo)
        expect(integrations.bar.patch).to.have.been.calledWith(bar)
      })
    })

    describe('unpatch', () => {
      it('should unpatch all modules', () => {
        instrumenter.unpatch()

        expect(integrations.foo.unpatch).to.have.been.calledWith(foo)
        expect(integrations.bar.unpatch).to.have.been.calledWith(bar)
      })
    })
  })

  describe('when disabled', () => {
    beforeEach(() => {
      instrumenter = new Instrumenter(tracer, { plugins: false })
    })

    describe('patch', () => {
      it('should not patch any module', () => {
        instrumenter.patch()

        expect(integrations.foo.patch).to.not.have.been.called
        expect(integrations.bar.patch).to.not.have.been.called
      })
    })

    describe('unpatch', () => {
      it('should not unpatch any module', () => {
        instrumenter.unpatch()

        expect(integrations.foo.unpatch).to.not.have.been.called
        expect(integrations.bar.unpatch).to.not.have.been.called
      })
    })
  })
})

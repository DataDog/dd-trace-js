'use strict'

const proxyquire = require('proxyquire').noCallThru()

describe('Instrumenter', () => {
  let Instrumenter
  let instrumenter
  let integrations
  let config
  let requireDir
  let foo
  let bar

  beforeEach(() => {
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
      config = { plugins: true }
      instrumenter = new Instrumenter(config)
    })

    describe('patch', () => {
      it('should patch all modules', () => {
        const tracer = 'tracer'

        instrumenter.patch(tracer)

        expect(integrations.foo.patch).to.have.been.calledWith(foo, tracer)
        expect(integrations.bar.patch).to.have.been.calledWith(bar, tracer)
      })
    })

    describe('unpatch', () => {
      it('should unpatch all modules', () => {
        const tracer = 'tracer'

        instrumenter.unpatch(tracer)

        expect(integrations.foo.unpatch).to.have.been.calledWith(foo, tracer)
        expect(integrations.bar.unpatch).to.have.been.calledWith(bar, tracer)
      })
    })
  })

  describe('when disabled', () => {
    beforeEach(() => {
      config = { plugins: false }
      instrumenter = new Instrumenter(config)
    })

    describe('patch', () => {
      it('should not patch any module', () => {
        const tracer = 'tracer'

        instrumenter.patch(tracer)

        expect(integrations.foo.patch).to.not.have.been.called
        expect(integrations.bar.patch).to.not.have.been.called
      })
    })

    describe('unpatch', () => {
      it('should not unpatch any module', () => {
        const tracer = 'tracer'

        instrumenter.unpatch(tracer)

        expect(integrations.foo.unpatch).to.not.have.been.called
        expect(integrations.bar.unpatch).to.not.have.been.called
      })
    })
  })
})

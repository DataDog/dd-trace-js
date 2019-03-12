'use strict'

describe('TracerProxy', () => {
  let Proxy
  let proxy
  let DatadogTracer
  let tracer
  let NoopTracer
  let noop
  let Instrumenter
  let instrumenter
  let Config
  let config
  let platform

  beforeEach(() => {
    tracer = {
      use: sinon.stub().returns('tracer'),
      trace: sinon.stub().returns('test'),
      wrap: sinon.stub().returns('fn'),
      startSpan: sinon.stub().returns('span'),
      inject: sinon.stub().returns('tracer'),
      extract: sinon.stub().returns('spanContext'),
      currentSpan: sinon.stub().returns('current'),
      scopeManager: sinon.stub().returns('scopeManager')
    }

    noop = {
      use: sinon.stub().returns('tracer'),
      trace: sinon.stub().returns('test'),
      wrap: sinon.stub().returns('fn'),
      startSpan: sinon.stub().returns('span'),
      inject: sinon.stub().returns('noop'),
      extract: sinon.stub().returns('spanContext'),
      currentSpan: sinon.stub().returns('current'),
      scopeManager: sinon.stub().returns('scopeManager')
    }

    instrumenter = {
      enable: sinon.spy(),
      patch: sinon.spy(),
      use: sinon.spy()
    }

    DatadogTracer = sinon.stub().returns(tracer)
    NoopTracer = sinon.stub().returns(noop)
    Instrumenter = sinon.stub().returns(instrumenter)

    config = { enabled: true }
    Config = sinon.stub().returns(config)

    platform = {
      load: sinon.spy(),
      uuid: sinon.stub().returns('1234'),
      metrics: sinon.stub().returns({
        start: sinon.spy()
      })
    }

    Proxy = proxyquire('../src/proxy', {
      './tracer': DatadogTracer,
      './noop/tracer': NoopTracer,
      './instrumenter': Instrumenter,
      './config': Config,
      './platform': platform
    })

    proxy = new Proxy()
  })

  describe('use', () => {
    it('should call the underlying instrumenter', () => {
      const returnValue = proxy.use('a', 'b', 'c')

      expect(instrumenter.use).to.have.been.calledWith('a', 'b', 'c')
      expect(returnValue).to.equal(proxy)
    })
  })

  describe('uninitialized', () => {
    describe('init', () => {
      it('should return itself', () => {
        expect(proxy.init()).to.equal(proxy)
      })

      it('should initialize and configure an instance of DatadogTracer', () => {
        const options = {}

        proxy.init(options)

        expect(Config).to.have.been.calledWith('dd-trace', '1234', options)
        expect(DatadogTracer).to.have.been.calledWith(config)
      })

      it('should not initialize twice', () => {
        proxy.init()
        proxy.init()

        expect(DatadogTracer).to.have.been.calledOnce
      })

      it('should not initialize when disabled', () => {
        config.enabled = false

        proxy.init()

        expect(DatadogTracer).to.not.have.been.called
      })

      it('should set up automatic instrumentation', () => {
        proxy.init()

        expect(instrumenter.enable).to.have.been.called
        expect(instrumenter.patch).to.have.been.called
      })

      it('should update the delegate before setting up instrumentation', () => {
        proxy.init()

        expect(instrumenter.patch).to.have.been.calledAfter(DatadogTracer)
      })

      it('should start capturing metrics', () => {
        proxy.init()

        expect(platform.metrics().start).to.have.been.called
      })
    })

    describe('trace', () => {
      it('should call the underlying NoopTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', 'b', callback)

        expect(noop.trace).to.have.been.calledWith('a', 'b', callback)
        expect(returnValue).to.equal('test')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', callback)

        expect(noop.trace).to.have.been.calledWith('a', {}, callback)
        expect(returnValue).to.equal('test')
      })

      it('should ignore calls without an invalid callback', () => {
        proxy.wrap('a', 'b')

        expect(noop.trace).to.not.have.been.called
      })
    })

    describe('wrap', () => {
      it('should call the underlying NoopTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', 'b', callback)

        expect(noop.wrap).to.have.been.calledWith('a', 'b', callback)
        expect(returnValue).to.equal('fn')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', callback)

        expect(noop.wrap).to.have.been.calledWith('a', {}, callback)
        expect(returnValue).to.equal('fn')
      })

      it('should ignore calls without an invalid callback', () => {
        const returnValue = proxy.wrap('a', 'b')

        expect(noop.wrap).to.not.have.been.called
        expect(returnValue).to.equal('b')
      })
    })

    describe('startSpan', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.startSpan('a', 'b', 'c')

        expect(noop.startSpan).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('span')
      })
    })

    describe('inject', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.inject('a', 'b', 'c')

        expect(noop.inject).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('noop')
      })
    })

    describe('extract', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.extract('a', 'b', 'c')

        expect(noop.extract).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('spanContext')
      })
    })

    describe('currentSpan', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.currentSpan('a', 'b', 'c')

        expect(noop.currentSpan).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('current')
      })
    })

    describe('scopeManager', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.scopeManager()

        expect(noop.scopeManager).to.have.been.called
        expect(returnValue).to.equal('scopeManager')
      })
    })
  })

  describe('initialized', () => {
    beforeEach(() => {
      proxy.init()
    })

    describe('use', () => {
      it('should call the underlying Instrumenter', () => {
        const returnValue = proxy.use('a', 'b', 'c')

        expect(instrumenter.use).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal(proxy)
      })
    })

    describe('trace', () => {
      it('should call the underlying DatadogTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', 'b', callback)

        expect(tracer.trace).to.have.been.calledWith('a', 'b', callback)
        expect(returnValue).to.equal('test')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', callback)

        expect(tracer.trace).to.have.been.calledWith('a', {}, callback)
        expect(returnValue).to.equal('test')
      })
    })

    describe('wrap', () => {
      it('should call the underlying DatadogTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', 'b', callback)

        expect(tracer.wrap).to.have.been.calledWith('a', 'b', callback)
        expect(returnValue).to.equal('fn')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', callback)

        expect(tracer.wrap).to.have.been.calledWith('a', {}, callback)
        expect(returnValue).to.equal('fn')
      })
    })

    describe('startSpan', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.startSpan('a', 'b', 'c')

        expect(tracer.startSpan).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('span')
      })
    })

    describe('inject', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.inject('a', 'b', 'c')

        expect(tracer.inject).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('tracer')
      })
    })

    describe('extract', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.extract('a', 'b', 'c')

        expect(tracer.extract).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('spanContext')
      })
    })

    describe('currentSpan', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.currentSpan('a', 'b', 'c')

        expect(tracer.currentSpan).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('current')
      })
    })

    describe('scopeManager', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.scopeManager()

        expect(tracer.scopeManager).to.have.been.called
        expect(returnValue).to.equal('scopeManager')
      })
    })
  })
})

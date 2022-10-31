'use strict'

describe('TracerProxy', () => {
  let Proxy
  let proxy
  let DatadogTracer
  let NoopTracer
  let tracer
  let NoopProxy
  let noop
  let Config
  let config
  let metrics
  let log
  let profiler
  let appsec
  let telemetry
  let iast
  let remoteConfig
  let RemoteConfigManager

  beforeEach(() => {
    process.env.DD_TRACE_MOCHA_ENABLED = false
    tracer = {
      use: sinon.stub().returns('tracer'),
      trace: sinon.stub().returns('test'),
      wrap: sinon.stub().returns('fn'),
      startSpan: sinon.stub().returns('span'),
      inject: sinon.stub().returns('tracer'),
      extract: sinon.stub().returns('spanContext'),
      setUrl: sinon.stub()
    }

    noop = {
      use: sinon.stub().returns('tracer'),
      trace: sinon.stub().returns('test'),
      wrap: sinon.stub().returns('fn'),
      startSpan: sinon.stub().returns('span'),
      inject: sinon.stub().returns('noop'),
      extract: sinon.stub().returns('spanContext'),
      setUrl: sinon.stub()
    }

    log = {
      use: sinon.spy(),
      toggle: sinon.spy(),
      error: sinon.spy()
    }

    DatadogTracer = sinon.stub().returns(tracer)
    NoopTracer = sinon.stub().returns(noop)

    config = {
      tags: {},
      tracing: true,
      experimental: {},
      logger: 'logger',
      debug: true,
      profiling: {},
      appsec: {},
      iast: {}
    }
    Config = sinon.stub().returns(config)

    metrics = {
      start: sinon.spy()
    }

    profiler = {
      start: sinon.spy()
    }

    appsec = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    telemetry = {
      start: sinon.spy()
    }

    iast = {
      enable: sinon.spy()
    }

    remoteConfig = {
      updateCapabilities: sinon.spy(),
      on: sinon.spy()
    }

    RemoteConfigManager = sinon.stub().returns(remoteConfig)

    NoopProxy = proxyquire('../src/noop/proxy', {
      './tracer': NoopTracer
    })

    Proxy = proxyquire('../src/proxy', {
      './tracer': DatadogTracer,
      './noop/proxy': NoopProxy,
      './config': Config,
      './metrics': metrics,
      './log': log,
      './profiler': profiler,
      './appsec': appsec,
      './appsec/iast': iast,
      './telemetry': telemetry,
      './remote_config': RemoteConfigManager
    })

    proxy = new Proxy()
  })

  describe('uninitialized', () => {
    describe('init', () => {
      it('should return itself', () => {
        expect(proxy.init()).to.equal(proxy)
      })

      it('should initialize and configure an instance of DatadogTracer', () => {
        const options = {}

        proxy.init(options)

        expect(Config).to.have.been.calledWith(options)
        expect(DatadogTracer).to.have.been.calledWith(config)
        expect(RemoteConfigManager).to.have.been.calledOnceWith(config)
      })

      it('should not initialize twice', () => {
        proxy.init()
        proxy.init()

        expect(DatadogTracer).to.have.been.calledOnce
        expect(RemoteConfigManager).to.have.been.calledOnce
      })

      it('should not initialize when disabled', () => {
        config.tracing = false

        proxy.init()

        expect(DatadogTracer).to.not.have.been.called
      })

      it('should support logging', () => {
        proxy.init()

        expect(log.use).to.have.been.calledWith(config.logger)
        expect(log.toggle).to.have.been.calledWith(config.debug)
      })

      it('should not capture metrics by default', () => {
        proxy.init()

        expect(metrics.start).to.not.have.been.called
      })

      it('should start capturing metrics when configured', () => {
        config.runtimeMetrics = true

        proxy.init()

        expect(metrics.start).to.have.been.called
      })

      it('should enable appsec when explicitly configured to true', () => {
        config.appsec = { enabled: true }

        proxy.init()

        expect(appsec.enable).to.have.been.called
        expect(remoteConfig.updateCapabilities).to.not.have.been.called
        expect(remoteConfig.on).to.not.have.been.called
      })

      it('should not enable appsec but listen to remote config when appsec is not explicitely configured', () => {
        config.appsec = { enabled: undefined }

        proxy.init()

        expect(appsec.enable).to.not.have.been.called
        expect(remoteConfig.updateCapabilities).to.have.been.calledOnceWithExactly(2n, true)
        expect(remoteConfig.on).to.have.been.calledOnceWith('ASM_FEATURES')
        expect(remoteConfig.on.firstCall.args[1]).to.be.a('function')
      })

      describe('ASM_FEATURES remote config listener', () => {
        let listener

        beforeEach(() => {
          config.appsec = { enabled: undefined }

          proxy.init()

          listener = remoteConfig.on.firstCall.args[1]
        })

        it('should enable appsec when listener is called with apply and enabled', () => {
          listener('apply', { asm: { enabled: true } })

          expect(appsec.enable).to.have.been.calledOnceWithExactly(config)
        })

        it('should enable appsec when listener is called with modify and enabled', () => {
          listener('modify', { asm: { enabled: true } })

          expect(appsec.enable).to.have.been.calledOnceWithExactly(config)
        })

        it('should disable appsec when listener is called with unnaply and enabled', () => {
          listener('unnaply', { asm: { enabled: true } })

          expect(appsec.disable).to.have.been.calledOnce
        })

        it('should not do anything when listener is called with apply and malformed data', () => {
          listener('apply', {})

          expect(appsec.enable).to.not.have.been.called
          expect(appsec.disable).to.not.have.been.called
        })
      })

      it('should not enable appsec when explicitely configured to false', () => {
        config.appsec = { enabled: false }

        proxy.init()

        expect(appsec.enable).to.not.have.been.called
        expect(remoteConfig.updateCapabilities).to.not.have.been.called
        expect(remoteConfig.on).to.not.have.been.called
      })

      it('should enable iast when configured', () => {
        config.iast = { enabled: true }

        proxy.init()

        expect(iast.enable).to.have.been.calledOnce
      })

      it('should not enable iast when it is not configured', () => {
        config.iast = {}

        proxy.init()

        expect(iast.enable).not.to.have.been.called
      })

      it('should not load the profiler when not configured', () => {
        config.profiling = { enabled: false }

        proxy.init()

        expect(profiler.start).to.not.have.been.called
      })

      it('should not load the profiler when profiling config does not exist', () => {
        config.pro_fil_ing = 'invalidConfig'

        proxy.init()

        expect(profiler.start).to.not.have.been.called
      })

      it('should load profiler when configured', () => {
        config.profiling = { enabled: true }

        proxy.init()

        expect(profiler.start).to.have.been.called
      })

      it('should throw an error since profiler fails to be imported', () => {
        config.profiling = { enabled: true }

        const ProfilerImportFailureProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './noop/tracer': NoopTracer,
          './config': Config,
          './metrics': metrics,
          './log': log,
          './profiler': null, // this will cause the import failure error
          './appsec': appsec,
          './remote_config': RemoteConfigManager
        })

        const profilerImportFailureProxy = new ProfilerImportFailureProxy()
        profilerImportFailureProxy.init()

        const expectedErr = sinon.match.instanceOf(Error).and(sinon.match.has('code', 'MODULE_NOT_FOUND'))
        sinon.assert.calledWith(log.error, sinon.match(expectedErr))
      })

      it('should start telemetry', () => {
        proxy.init()

        expect(telemetry.start).to.have.been.called
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

    describe('setUrl', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.setUrl('http://example.com')

        expect(noop.setUrl).to.have.been.calledWith('http://example.com')
        expect(returnValue).to.equal(proxy)
      })
    })
  })

  describe('initialized', () => {
    beforeEach(() => {
      proxy.init()
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

    describe('setUrl', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.setUrl('http://example.com')

        expect(tracer.setUrl).to.have.been.calledWith('http://example.com')
        expect(returnValue).to.equal(proxy)
      })
    })
  })
})

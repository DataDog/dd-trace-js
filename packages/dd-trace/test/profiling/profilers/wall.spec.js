'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('profilers/native/wall', () => {
  let NativeWallProfiler
  let pprof
  let profile0

  beforeEach(() => {
    profile0 = {
      encodeAsync: sinon.stub().returns(Promise.resolve('encoded')),
    }
    pprof = {
      time: {
        start: sinon.stub(),
        stop: sinon.stub().returns(profile0),
        setContext: sinon.stub(),
        v8ProfilerStuckEventLoopDetected: sinon.stub().returns(false),
        constants: {
          kSampleCount: 0,
          NON_JS_THREADS_FUNCTION_NAME: 'Non JS threads activity',
        },
        getState: sinon.stub().returns({ 0: 0 }),
        getMetrics: sinon.stub().returns({
          totalAsyncContextCount: 0,
          usedAsyncContextCount: 0,
        }),
      },
    }

    NativeWallProfiler = proxyquire('../../../src/profiling/profilers/wall', {
      '@datadog/pprof': pprof,
    })
  })

  it('should start the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    // Verify start/stop profiler idle notifiers are created if not present.
    // These functions may not exist in worker threads.
    // @ts-expect-error: _startProfilerIdleNotifier is not typed on process
    const start = process._startProfilerIdleNotifier
    // @ts-expect-error: _stopProfilerIdleNotifier is not typed on process
    const stop = process._stopProfilerIdleNotifier

    // @ts-expect-error: _startProfilerIdleNotifier is not typed on process
    delete process._startProfilerIdleNotifier
    // @ts-expect-error: _stopProfilerIdleNotifier is not typed on process
    delete process._stopProfilerIdleNotifier

    profiler.start()

    // @ts-expect-error: _startProfilerIdleNotifier is not typed on process
    assert.strictEqual(typeof process._startProfilerIdleNotifier, 'function')
    // @ts-expect-error: _stopProfilerIdleNotifier is not typed on process
    assert.strictEqual(typeof process._stopProfilerIdleNotifier, 'function')

    // @ts-expect-error: _startProfilerIdleNotifier is not typed on process
    process._startProfilerIdleNotifier = start
    // @ts-expect-error: _stopProfilerIdleNotifier is not typed on process
    process._stopProfilerIdleNotifier = stop

    sinon.assert.calledOnce(pprof.time.start)
    sinon.assert.calledWith(pprof.time.start,
      {
        intervalMicros: 1e6 / 99,
        durationMillis: 60000,
        sourceMapper: undefined,
        withContexts: false,
        lineNumbers: false,
        workaroundV8Bug: false,
        collectCpuTime: false,
        useCPED: false,
      })
  })

  it('should use the provided configuration options', () => {
    const samplingInterval = 0.5
    const profiler = new NativeWallProfiler({ samplingInterval })

    profiler.start()
    profiler.stop()

    sinon.assert.calledWith(pprof.time.start,
      {
        intervalMicros: 500,
        durationMillis: 60000,
        sourceMapper: undefined,
        withContexts: false,
        lineNumbers: false,
        workaroundV8Bug: false,
        collectCpuTime: false,
        useCPED: false,
      })
  })

  it('should not stop when not started', () => {
    const profiler = new NativeWallProfiler()

    profiler.stop()

    sinon.assert.notCalled(pprof.time.stop)
  })

  it('should stop the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()
    profiler.stop()

    sinon.assert.calledOnce(pprof.time.stop)
  })

  it('should stop the internal time profiler only once', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()
    profiler.stop()
    profiler.stop()

    sinon.assert.calledOnce(pprof.time.stop)
  })

  it('should provide info', () => {
    const profiler = new NativeWallProfiler()
    profiler.start()
    const info = profiler.getInfo()
    profiler.stop()

    assert.notStrictEqual(info.totalAsyncContextCount, undefined)
    assert.notStrictEqual(info.usedAsyncContextCount, undefined)
  })

  it('should collect profiles from the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    assert.strictEqual(profiler.isStarted(), false)
    profiler.start()
    assert.strictEqual(profiler.isStarted(), true)

    const profile = profiler.profile(true)

    assert.strictEqual(profile, profile0)

    sinon.assert.calledOnce(pprof.time.stop)
    sinon.assert.calledOnce(pprof.time.start)
    assert.strictEqual(profiler.isStarted(), true)
    profiler.stop()
    assert.strictEqual(profiler.isStarted(), false)
    sinon.assert.calledTwice(pprof.time.stop)
  })

  it('should collect profiles from the internal time profiler and stop profiler if not restarted', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()

    const profile = profiler.profile(false)

    assert.strictEqual(profile, profile0)

    sinon.assert.calledOnce(pprof.time.stop)
    sinon.assert.calledOnce(pprof.time.start)
    assert.strictEqual(profiler.isStarted(), false)
    profiler.stop()
    sinon.assert.calledOnce(pprof.time.stop)
  })

  it('should encode profiles calling their encodeAsync method', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()

    const profile = profiler.profile(true)

    profiler.encode(profile)

    profiler.stop()

    sinon.assert.calledOnce(profile0.encodeAsync)
  })

  it('should use mapper if given', () => {
    const profiler = new NativeWallProfiler()

    const mapper = {}

    profiler.start({ mapper })
    profiler.stop()

    sinon.assert.calledWith(pprof.time.start,
      {
        intervalMicros: 1e6 / 99,
        durationMillis: 60000,
        sourceMapper: mapper,
        withContexts: false,
        lineNumbers: false,
        workaroundV8Bug: false,
        collectCpuTime: false,
        useCPED: false,
      })
  })

  it('should generate appropriate sample labels', () => {
    const profiler = new NativeWallProfiler({ timelineEnabled: true })
    profiler.start()
    profiler.stop()

    function expectLabels (context, expected) {
      const actual = profiler._generateLabels({ node: {}, context })
      assert.deepStrictEqual(actual, expected)
    }

    assert.deepStrictEqual(profiler._generateLabels({ node: { name: 'Non JS threads activity' } }), {
      'thread name': 'Non-JS threads',
      'thread id': 'NA',
      'os thread id': 'NA',
    })

    const shared = require('../../../src/profiling/profilers/shared')
    const nativeThreadId = shared.getThreadLabels()['os thread id']
    const threadInfo = {
      'thread name': 'Main Event Loop',
      'thread id': '0',
      'os thread id': nativeThreadId,
    }

    expectLabels(undefined, threadInfo)

    const threadInfoWithTimestamp = {
      ...threadInfo,
      end_timestamp_ns: 1234000n,
    }

    expectLabels({ timestamp: 1234n }, threadInfoWithTimestamp)

    expectLabels({ timestamp: 1234n, asyncId: -1 }, threadInfoWithTimestamp)

    expectLabels({ timestamp: 1234n, asyncId: 1 }, {
      ...threadInfoWithTimestamp,
      'async id': 1,
    })

    expectLabels({ timestamp: 1234n, context: {} }, threadInfoWithTimestamp)

    expectLabels({ timestamp: 1234n, context: { ref: {} } }, threadInfoWithTimestamp)

    expectLabels({ timestamp: 1234n, context: { ref: { spanId: 'foo' } } }, {
      ...threadInfoWithTimestamp,
      'span id': 'foo',
    })

    expectLabels({ timestamp: 1234n, context: { ref: { rootSpanId: 'foo' } } }, {
      ...threadInfoWithTimestamp,
      'local root span id': 'foo',
    })

    expectLabels({
      timestamp: 1234n,
      context: { ref: { webTags: { 'http.method': 'GET', 'http.route': '/foo/bar' } } },
    }, {
      ...threadInfoWithTimestamp,
      'trace endpoint': 'GET /foo/bar',
    })

    expectLabels({ timestamp: 1234n, context: { ref: { endpoint: 'GET /foo/bar/2' } } }, {
      ...threadInfoWithTimestamp,
      'trace endpoint': 'GET /foo/bar/2',
    })

    // All at once
    expectLabels({
      timestamp: 1234n,
      asyncId: 2,
      context: {
        ref: {
          spanId: '1234567890',
          rootSpanId: '0987654321',
          webTags: { 'http.method': 'GET', 'http.route': '/foo/bar' },
        },
      },
    }, {
      ...threadInfoWithTimestamp,
      'async id': 2,
      'span id': '1234567890',
      'local root span id': '0987654321',
      'trace endpoint': 'GET /foo/bar',
    })
  })

  describe('webTags caching in getProfilingContext', () => {
    // TracingPlugin.startSpan() calls storage.enterWith({span}) immediately on span
    // creation, before the plugin calls addRequestTags() to set span.type='web'.
    // This means the first enterCh event fires with span.type unset. The profiler
    // caches the profilingContext with webTags=undefined. When addRequestTags()
    // later sets span.type='web', the dd-trace:span:tags:update channel fires and
    // the profiler updates the cached context's webTags in place.
    let enterCh
    let tagsUpdateCh
    let currentStore
    let localPprof
    let WallProfiler

    beforeEach(() => {
      enterCh = dc.channel('dd-trace:storage:enter')
      tagsUpdateCh = dc.channel('dd-trace:span:tags:update')
      currentStore = null

      // Fresh setContext stub so we can track calls independently per test.
      localPprof = {
        ...pprof,
        time: {
          ...pprof.time,
          setContext: sinon.stub(),
        },
      }

      WallProfiler = proxyquire('../../../src/profiling/profilers/wall', {
        '@datadog/pprof': localPprof,
        '../../../../datadog-core': {
          storage: () => ({
            getStore: () => currentStore,
            enterWith () {},
            run (store, cb, ...args) { return cb(...args) },
          }),
        },
      })
    })

    function makeWebSpan () {
      const tags = {}
      const spanId = {}
      const ctx = { _tags: tags, _spanId: spanId, _parentId: null, _trace: { started: [] } }
      const span = { context: () => ctx }
      ctx._trace.started.push(span)
      return { span, tags, spanId }
    }

    function makeChildSpan (webSpanId, webSpan) {
      const tags = { 'span.type': 'router' }
      const spanId = {}
      const ctx = { _tags: tags, _spanId: spanId, _parentId: webSpanId, _trace: { started: [webSpan] } }
      const span = { context: () => ctx }
      ctx._trace.started.push(span)
      return { span, tags }
    }

    it('should resolve webTags via tags update channel (ACF path)', () => {
      const { span: webSpan, tags: webSpanTags } = makeWebSpan()
      const profiler = new WallProfiler({
        endpointCollectionEnabled: true,
        codeHotspotsEnabled: true,
        asyncContextFrameEnabled: true,
      })
      profiler.start()

      // First activation: span.type not yet set → webTags cached as undefined
      currentStore = { span: webSpan }
      enterCh.publish()
      const ctx0 = localPprof.time.setContext.getCall(0).args[0]
      assert.strictEqual(ctx0.webTags, undefined)

      // Re-activation alone won't resolve webTags — cached context returned as-is
      webSpanTags['span.type'] = 'web'
      enterCh.publish()
      assert.strictEqual(localPprof.time.setContext.getCall(1).args[0], ctx0)
      assert.strictEqual(ctx0.webTags, undefined)

      // The tags update channel resolves it in place — no re-activation needed
      tagsUpdateCh.publish(webSpan)
      assert.strictEqual(ctx0.webTags, webSpanTags)

      profiler.stop()
    })

    it('should resolve webTags via tags update channel (non-ACF path)', () => {
      const { span: webSpan, tags: webSpanTags } = makeWebSpan()
      const profiler = new WallProfiler({
        endpointCollectionEnabled: true,
        codeHotspotsEnabled: true,
        asyncContextFrameEnabled: false,
      })
      profiler.start()

      const contextHolder = localPprof.time.setContext.getCall(0).args[0]

      // First activation: span.type not yet set → webTags cached as undefined
      currentStore = { span: webSpan }
      enterCh.publish()
      assert.strictEqual(contextHolder.ref.webTags, undefined)

      // Re-activation alone won't resolve webTags — cached context returned as-is
      webSpanTags['span.type'] = 'web'
      enterCh.publish()
      assert.strictEqual(contextHolder.ref.webTags, undefined)

      // The tags update channel resolves it in place through the ref
      tagsUpdateCh.publish(webSpan)
      assert.strictEqual(contextHolder.ref.webTags, webSpanTags)

      profiler.stop()
    })

    it('should propagate webTags to child spans after tags update resolves parent (ACF path)', () => {
      const { span: webSpan, tags: webSpanTags, spanId: webSpanId } = makeWebSpan()
      const { span: childSpan } = makeChildSpan(webSpanId, webSpan)

      const profiler = new WallProfiler({
        endpointCollectionEnabled: true,
        codeHotspotsEnabled: true,
        asyncContextFrameEnabled: true,
      })
      profiler.start()

      // Activate web span, then resolve via tags update channel
      currentStore = { span: webSpan }
      enterCh.publish()
      webSpanTags['span.type'] = 'web'
      tagsUpdateCh.publish(webSpan)

      // Now activate the child span — it must inherit webTags via parent walk
      currentStore = { span: childSpan }
      enterCh.publish()
      const childCtx = localPprof.time.setContext.lastCall.args[0]
      assert.strictEqual(childCtx.webTags, webSpanTags)

      profiler.stop()
    })

    it('should not update webTags for non-web spans via tags update channel', () => {
      const { span: webSpan, spanId: webSpanId } = makeWebSpan()
      const { span: childSpan } = makeChildSpan(webSpanId, webSpan)

      const profiler = new WallProfiler({
        endpointCollectionEnabled: true,
        codeHotspotsEnabled: true,
        asyncContextFrameEnabled: true,
      })
      profiler.start()

      // Activate child span (router type)
      currentStore = { span: childSpan }
      enterCh.publish()
      const childCtx = localPprof.time.setContext.lastCall.args[0]

      // Tags update on child span should not set webTags (it's not a web span)
      tagsUpdateCh.publish(childSpan)
      assert.strictEqual(childCtx.webTags, undefined)

      profiler.stop()
    })

    it('should ignore tags update for spans without cached profiling context', () => {
      const { span: webSpan, tags: webSpanTags } = makeWebSpan()
      const profiler = new WallProfiler({
        endpointCollectionEnabled: true,
        codeHotspotsEnabled: true,
        asyncContextFrameEnabled: true,
      })
      profiler.start()

      // Publish tags update before the span is ever activated — no cached context
      webSpanTags['span.type'] = 'web'
      tagsUpdateCh.publish(webSpan)

      // No setContext call beyond the initial setup
      sinon.assert.notCalled(localPprof.time.setContext)

      profiler.stop()
    })

    it('should not update already-resolved webTags via tags update channel', () => {
      const { span: webSpan, tags: webSpanTags } = makeWebSpan()
      webSpanTags['span.type'] = 'web'

      const profiler = new WallProfiler({
        endpointCollectionEnabled: true,
        codeHotspotsEnabled: true,
        asyncContextFrameEnabled: true,
      })
      profiler.start()

      // Activate with span.type already set → webTags resolved immediately
      currentStore = { span: webSpan }
      enterCh.publish()
      const ctx0 = localPprof.time.setContext.getCall(0).args[0]
      assert.strictEqual(ctx0.webTags, webSpanTags)

      // Tags update should be a no-op since webTags is already set
      tagsUpdateCh.publish(webSpan)
      assert.strictEqual(ctx0.webTags, webSpanTags)

      profiler.stop()
    })
  })
})

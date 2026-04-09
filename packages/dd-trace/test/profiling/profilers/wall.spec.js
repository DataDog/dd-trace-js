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

  describe('_generateLabels with custom labels (ACF)', () => {
    it('should include custom labels from array context', () => {
      const profiler = new NativeWallProfiler({
        timelineEnabled: true,
        asyncContextFrameEnabled: true,
      })
      profiler.start()
      profiler.stop()

      const shared = require('../../../src/profiling/profilers/shared')
      const nativeThreadId = shared.getThreadLabels()['os thread id']
      const threadInfo = {
        'thread name': 'Main Event Loop',
        'thread id': '0',
        'os thread id': nativeThreadId,
      }

      // Array context: [profilingContext, customLabels]
      const actual = profiler._generateLabels({
        node: {},
        context: {
          timestamp: 1234n,
          context: [
            { spanId: '123', rootSpanId: '456' },
            { customer: 'acme', region: 'us-east' },
          ],
        },
      })

      assert.deepStrictEqual(actual, {
        ...threadInfo,
        end_timestamp_ns: 1234000n,
        'span id': '123',
        'local root span id': '456',
        customer: 'acme',
        region: 'us-east',
      })
    })

    it('should handle array context with empty profiling context', () => {
      const profiler = new NativeWallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()
      profiler.stop()

      const shared = require('../../../src/profiling/profilers/shared')
      const nativeThreadId = shared.getThreadLabels()['os thread id']
      const threadInfo = {
        'thread name': 'Main Event Loop',
        'thread id': '0',
        'os thread id': nativeThreadId,
      }

      // ref is not an object (e.g. undefined) but custom labels exist
      const actual = profiler._generateLabels({
        node: {},
        context: {
          context: [undefined, { tier: 'premium' }],
        },
      })

      assert.deepStrictEqual(actual, {
        ...threadInfo,
        tier: 'premium',
      })
    })

    it('should not treat non-ACF ref context as array', () => {
      const profiler = new NativeWallProfiler({
        timelineEnabled: true,
        asyncContextFrameEnabled: false,
      })
      profiler.start()
      profiler.stop()

      const shared = require('../../../src/profiling/profilers/shared')
      const nativeThreadId = shared.getThreadLabels()['os thread id']
      const threadInfo = {
        'thread name': 'Main Event Loop',
        'thread id': '0',
        'os thread id': nativeThreadId,
      }

      // In non-ACF mode, context.context.ref is used, not context.context
      const actual = profiler._generateLabels({
        node: {},
        context: {
          timestamp: 1234n,
          context: { ref: { spanId: '789' } },
        },
      })

      assert.deepStrictEqual(actual, {
        ...threadInfo,
        end_timestamp_ns: 1234000n,
        'span id': '789',
      })
    })
  })

  describe('runWithLabels', () => {
    let enterCh
    let currentStore
    let localPprof
    let WallProfiler

    beforeEach(() => {
      enterCh = dc.channel('dd-trace:storage:enter')
      currentStore = null

      localPprof = {
        ...pprof,
        time: {
          ...pprof.time,
          setContext: sinon.stub(),
          getContext: sinon.stub(),
          runWithContext: sinon.stub(),
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

    it('should call runWithContext with array context when ACF is enabled', () => {
      localPprof.time.getContext.returns({ spanId: '123' })
      localPprof.time.runWithContext.callsFake((ctx, fn) => fn())

      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()

      let called = false
      profiler.runWithLabels({ customer: 'acme' }, () => { called = true })

      assert.ok(called)
      sinon.assert.calledOnce(localPprof.time.runWithContext)
      const [ctx] = localPprof.time.runWithContext.firstCall.args
      assert.ok(Array.isArray(ctx))
      assert.deepStrictEqual(ctx[0], { spanId: '123' })
      assert.deepStrictEqual(ctx[1], { customer: 'acme' })

      profiler.stop()
    })

    it('should merge labels when nested', () => {
      // Outer call: no existing array context
      localPprof.time.getContext.onFirstCall().returns({ spanId: '123' })
      // Inner call: existing array context from outer call
      localPprof.time.getContext.onSecondCall().returns([{ spanId: '123' }, { customer: 'acme' }])
      localPprof.time.runWithContext.callsFake((ctx, fn) => fn())

      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()

      profiler.runWithLabels({ customer: 'acme' }, () => {
        profiler.runWithLabels({ region: 'us-east' }, () => {})
      })

      const innerCtx = localPprof.time.runWithContext.secondCall.args[0]
      assert.ok(Array.isArray(innerCtx))
      assert.deepStrictEqual(innerCtx[0], { spanId: '123' })
      assert.deepStrictEqual(innerCtx[1], { customer: 'acme', region: 'us-east' })

      profiler.stop()
    })

    it('should override outer labels with inner labels of same key', () => {
      localPprof.time.getContext.onFirstCall().returns({})
      localPprof.time.getContext.onSecondCall().returns([{}, { customer: 'acme' }])
      localPprof.time.runWithContext.callsFake((ctx, fn) => fn())

      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()

      profiler.runWithLabels({ customer: 'acme' }, () => {
        profiler.runWithLabels({ customer: 'beta' }, () => {})
      })

      const innerCtx = localPprof.time.runWithContext.secondCall.args[0]
      assert.deepStrictEqual(innerCtx[1], { customer: 'beta' })

      profiler.stop()
    })

    it('should passthrough when ACF is not enabled', () => {
      const profiler = new WallProfiler({
        asyncContextFrameEnabled: false,
        codeHotspotsEnabled: true,
      })
      profiler.start()

      let called = false
      const result = profiler.runWithLabels({ customer: 'acme' }, () => {
        called = true
        return 42
      })

      assert.ok(called)
      assert.strictEqual(result, 42)
      sinon.assert.notCalled(localPprof.time.runWithContext)

      profiler.stop()
    })

    it('should passthrough when contexts are not enabled', () => {
      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
      })
      profiler.start()

      let called = false
      profiler.runWithLabels({ customer: 'acme' }, () => { called = true })

      assert.ok(called)
      sinon.assert.notCalled(localPprof.time.runWithContext)

      profiler.stop()
    })

    it('should let internal labels overwrite custom labels with same key', () => {
      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()
      profiler.stop()

      const shared = require('../../../src/profiling/profilers/shared')
      const nativeThreadId = shared.getThreadLabels()['os thread id']

      // Custom label collides with internal 'span id' label
      const actual = profiler._generateLabels({
        node: {},
        context: {
          context: [
            { spanId: '123' },
            { 'span id': 'should-be-overwritten', customer: 'acme' },
          ],
        },
      })

      assert.deepStrictEqual(actual, {
        'thread name': 'Main Event Loop',
        'thread id': '0',
        'os thread id': nativeThreadId,
        'span id': '123',
        customer: 'acme',
      })
    })

    it('should preserve custom labels in #enter when custom labels are active', () => {
      const customLabelsCtx = [{ spanId: '123' }, { customer: 'acme' }]
      localPprof.time.getContext.returns(customLabelsCtx)
      localPprof.time.runWithContext.callsFake((ctx, fn) => {
        // Simulate #enter being called inside runWithContext scope
        currentStore = { span: null }
        enterCh.publish()
        return fn()
      })

      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()

      profiler.runWithLabels({ customer: 'acme' }, () => {})

      // Verify that setContext was called with an array preserving custom labels
      const setContextCall = localPprof.time.setContext.lastCall
      assert.ok(setContextCall, 'setContext should have been called')
      const setCtx = setContextCall.args[0]
      assert.ok(Array.isArray(setCtx), 'setContext should receive an array when custom labels are active')
      assert.deepStrictEqual(setCtx[1], { customer: 'acme' })

      profiler.stop()
    })

    it('should skip setContext when profiling context is unchanged (array)', () => {
      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()

      // Activate custom labels
      localPprof.time.getContext.returns({})
      localPprof.time.runWithContext.callsFake((ctx, fn) => fn())
      profiler.runWithLabels({ customer: 'acme' }, () => {})

      // Now simulate #enter where the profiling context is the same object
      const sameCtx = { spanId: '123' }
      localPprof.time.getContext.returns([sameCtx, { customer: 'acme' }])

      // Make getActiveSpan return a span that produces sameCtx
      const spanCtx = { _spanId: {}, _parentId: null, _tags: {}, _trace: { started: [] } }
      const span = { context: () => spanCtx }
      spanCtx._trace.started.push(span)
      currentStore = { span }

      // First enter — sets context
      enterCh.publish()
      const callCountAfterFirst = localPprof.time.setContext.callCount

      // Second enter with same span — getActiveSpan returns same cached context
      const lastCtx = localPprof.time.setContext.lastCall?.args[0]?.[0] ?? sameCtx
      localPprof.time.getContext.returns([lastCtx, { customer: 'acme' }])
      enterCh.publish()

      // setContext should not have been called again since the profiling context is the same object
      assert.strictEqual(localPprof.time.setContext.callCount, callCountAfterFirst)

      profiler.stop()
    })

    it('should skip setContext when context is unchanged (non-array)', () => {
      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()

      // Activate the monotonic flag
      localPprof.time.getContext.returns({})
      localPprof.time.runWithContext.callsFake((ctx, fn) => fn())
      profiler.runWithLabels({ customer: 'acme' }, () => {})

      // Simulate an async context without custom labels
      const sameCtx = { spanId: '456' }
      const spanCtx = { _spanId: {}, _parentId: null, _tags: {}, _trace: { started: [] } }
      const span = { context: () => spanCtx }
      spanCtx._trace.started.push(span)
      currentStore = { span }

      // First enter — sets context
      localPprof.time.getContext.returns(sameCtx)
      enterCh.publish()
      const callCountAfterFirst = localPprof.time.setContext.callCount

      // Second enter — getContext returns the same object that was just set
      const lastSet = localPprof.time.setContext.lastCall.args[0]
      localPprof.time.getContext.returns(lastSet)
      enterCh.publish()

      // setContext should not have been called again
      assert.strictEqual(localPprof.time.setContext.callCount, callCountAfterFirst)

      profiler.stop()
    })

    it('should preserve custom labels in #enter for async continuations after runWithLabels returns', () => {
      // After runWithLabels returns, async continuations still carry the custom
      // labels in their CPED frame. The monotonic flag ensures #enter checks.
      const profiler = new WallProfiler({
        asyncContextFrameEnabled: true,
        codeHotspotsEnabled: true,
      })
      profiler.start()

      // First call sets the monotonic flag
      localPprof.time.getContext.returns({})
      localPprof.time.runWithContext.callsFake((ctx, fn) => fn())
      profiler.runWithLabels({ customer: 'acme' }, () => {})

      // Now simulate an async continuation where getContext returns array
      // (CPED frame from the runWithContext scope is restored)
      localPprof.time.getContext.returns([{ spanId: '789' }, { customer: 'acme' }])
      currentStore = { span: null }
      enterCh.publish()

      // #enter should have preserved the custom labels
      const setCtx = localPprof.time.setContext.lastCall.args[0]
      assert.ok(Array.isArray(setCtx), 'setContext should receive an array for async continuations')
      assert.deepStrictEqual(setCtx[1], { customer: 'acme' })

      profiler.stop()
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

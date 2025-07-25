'use strict'

require('../../setup/tap')

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('profilers/native/wall', () => {
  let NativeWallProfiler
  let pprof
  let profile0

  beforeEach(() => {
    profile0 = {
      encodeAsync: sinon.stub().returns(Promise.resolve('encoded'))
    }
    pprof = {
      time: {
        start: sinon.stub(),
        stop: sinon.stub().returns(profile0),
        setContext: sinon.stub(),
        v8ProfilerStuckEventLoopDetected: sinon.stub().returns(false),
        constants: {
          kSampleCount: 0,
          NON_JS_THREADS_FUNCTION_NAME: 'Non JS threads activity'
        }
      }
    }

    NativeWallProfiler = proxyquire('../../../src/profiling/profilers/wall', {
      '@datadog/pprof': pprof
    })
  })

  it('should start the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    // Verify start/stop profiler idle notifiers are created if not present.
    // These functions may not exist in worker threads.
    const start = process._startProfilerIdleNotifier
    const stop = process._stopProfilerIdleNotifier

    delete process._startProfilerIdleNotifier
    delete process._stopProfilerIdleNotifier

    profiler.start()

    expect(process._startProfilerIdleNotifier).to.be.a('function')
    expect(process._stopProfilerIdleNotifier).to.be.a('function')

    process._startProfilerIdleNotifier = start
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
        collectCpuTime: false
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
        collectCpuTime: false
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

  it('should collect profiles from the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    expect(profiler.isStarted()).to.be.false
    profiler.start()
    expect(profiler.isStarted()).to.be.true

    const profile = profiler.profile(true)

    expect(profile).to.be.equal(profile0)

    sinon.assert.calledOnce(pprof.time.stop)
    sinon.assert.calledOnce(pprof.time.start)
    expect(profiler.isStarted()).to.be.true
    profiler.stop()
    expect(profiler.isStarted()).to.be.false
    sinon.assert.calledTwice(pprof.time.stop)
  })

  it('should collect profiles from the internal time profiler and stop profiler if not restarted', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()

    const profile = profiler.profile(false)

    expect(profile).to.equal(profile0)

    sinon.assert.calledOnce(pprof.time.stop)
    sinon.assert.calledOnce(pprof.time.start)
    expect(profiler.isStarted()).to.be.false
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
        collectCpuTime: false
      })
  })

  it('should generate appropriate sample labels', () => {
    const profiler = new NativeWallProfiler({ timelineEnabled: true })
    profiler.start()
    profiler.stop()

    function expectLabels (context, expected) {
      const actual = profiler._generateLabels({ node: {}, context })
      expect(actual).to.deep.equal(expected)
    }

    expect(profiler._generateLabels({ node: { name: 'Non JS threads activity' } })).to.deep.equal({
      'thread name': 'Non-JS threads',
      'thread id': 'NA',
      'os thread id': 'NA'
    })

    const shared = require('../../../src/profiling/profilers/shared')
    const nativeThreadId = shared.getThreadLabels()['os thread id']
    const threadInfo = {
      'thread name': 'Main Event Loop',
      'thread id': '0',
      'os thread id': nativeThreadId
    }

    expectLabels(undefined, threadInfo)

    const threadInfoWithTimestamp = {
      ...threadInfo,
      end_timestamp_ns: 1234000n
    }

    expectLabels({ timestamp: 1234n }, threadInfoWithTimestamp)

    expectLabels({ timestamp: 1234n, asyncId: -1 }, threadInfoWithTimestamp)

    expectLabels({ timestamp: 1234n, asyncId: 1 }, {
      ...threadInfoWithTimestamp,
      'async id': 1
    })

    expectLabels({ timestamp: 1234n, context: {} }, threadInfoWithTimestamp)

    expectLabels({ timestamp: 1234n, context: { ref: {} } }, threadInfoWithTimestamp)

    expectLabels({ timestamp: 1234n, context: { ref: { spanId: 'foo' } } }, {
      ...threadInfoWithTimestamp,
      'span id': 'foo'
    })

    expectLabels({ timestamp: 1234n, context: { ref: { rootSpanId: 'foo' } } }, {
      ...threadInfoWithTimestamp,
      'local root span id': 'foo'
    })

    expectLabels({
      timestamp: 1234n,
      context: { ref: { webTags: { 'http.method': 'GET', 'http.route': '/foo/bar' } } }
    }, {
      ...threadInfoWithTimestamp,
      'trace endpoint': 'GET /foo/bar'
    })

    expectLabels({ timestamp: 1234n, context: { ref: { endpoint: 'GET /foo/bar/2' } } }, {
      ...threadInfoWithTimestamp,
      'trace endpoint': 'GET /foo/bar/2'
    })

    // All at once
    expectLabels({
      timestamp: 1234n,
      asyncId: 2,
      context: {
        ref: {
          spanId: '1234567890',
          rootSpanId: '0987654321',
          webTags: { 'http.method': 'GET', 'http.route': '/foo/bar' }
        }
      }
    }, {
      ...threadInfoWithTimestamp,
      'async id': 2,
      'span id': '1234567890',
      'local root span id': '0987654321',
      'trace endpoint': 'GET /foo/bar'
    })
  })
})

'use strict'

const assert = require('node:assert/strict')
const { constants, performance } = require('node:perf_hooks')

const { afterEach, describe, it } = require('mocha')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

require('../../setup/core')
const { storage } = require('../../../../datadog-core')
const { getConfigFresh } = require('../../helpers/config')
const { availableParallelism, effectiveLibuvThreadCount } = require('../../../src/profiling/libuv-size')
const { SAMPLING_INTERVAL } = require('../../../src/profiling/constants')
const EventsProfiler = require('../../../src/profiling/profilers/events')

const startCh = dc.channel('apm:dns:lookup:start')
const finishCh = dc.channel('apm:dns:lookup:finish')

// Test adapter: the constructor reads canonical DD_PROFILING_* names off the tracer config plus the
// derived flush interval. The sampling interval is a fixed constant the profiler imports directly,
// so it is no longer a configurable option.
function makeEvents (Cls, { codeHotspotsEnabled, flushInterval, timelineSamplingEnabled } = {}) {
  return new Cls({
    DD_PROFILING_CODEHOTSPOTS_ENABLED: codeHotspotsEnabled,
    DD_INTERNAL_PROFILING_TIMELINE_SAMPLING_ENABLED: timelineSamplingEnabled,
  }, { flushInterval })
}

// The pprof profile of a captured profile, as the profiler builds it
function toPprof (profiler, captured) {
  const { PprofProfileBuilder } = require('@datadog/pprof')
  const builder = new PprofProfileBuilder(profiler.pprofBuilderOptions)
  captured.visit(builder.visitor())
  return builder.build()
}

function collectLabels (sample, stringTable) {
  const labels = {}
  for (const label of sample.label) {
    const key = stringTable.strings[label.key]
    labels[key] = label.str ? stringTable.strings[label.str] : label.num
  }
  return labels
}

function runOnceAndProfile (startChannel, finishChannel, ctx) {
  const profiler = makeEvents(EventsProfiler, {
    flushInterval: 65_000,
    timelineSamplingEnabled: false,
    codeHotspotsEnabled: true,
  })
  const startTime = new Date()
  profiler.start()
  try {
    startChannel.publish(ctx)
    finishChannel.publish(ctx)
    return toPprof(profiler, profiler.profile(true, startTime, new Date()))
  } finally {
    profiler.stop()
  }
}

function getProfilerConfig (tracerOptions) {
  const tracerConfig = getConfigFresh(tracerOptions)
  return {
    codeHotspotsEnabled: tracerConfig.DD_PROFILING_CODEHOTSPOTS_ENABLED,
    flushInterval: tracerConfig.DD_PROFILING_UPLOAD_PERIOD * 1000,
    timelineSamplingEnabled: tracerConfig.DD_INTERNAL_PROFILING_TIMELINE_SAMPLING_ENABLED,
  }
}

describe('profilers/events', () => {
  afterEach(() => {
    storage('legacy').enterWith(undefined)
  })

  it('should provide info', () => {
    const info = makeEvents(EventsProfiler, getProfilerConfig()).getInfo()
    assert(info.maxSamples > 0, `Expected ${info.maxSamples} > 0`)
  })

  it('should limit the number of events', async () => {
    // The sampling interval is a fixed constant now, so steer maxSamples through the flush interval:
    // getMaxSamples divides flushInterval by the sampling interval, so a whole multiple keeps the
    // expected count exact and small enough to test the reservoir cap deterministically.
    const maxCpuSamples = 2
    const flushInterval = SAMPLING_INTERVAL * maxCpuSamples
    // Set up a mock span to simulate tracing context
    const span = {
      context: () => ({
        toBigIntSpanId: () => 1234n,
        _trace: {
          started: [span],
        },
      }),
    }
    storage('legacy').enterWith({ span })

    const profiler = makeEvents(EventsProfiler, {
      flushInterval,
      timelineSamplingEnabled: false, // don't discard any events
      codeHotspotsEnabled: true, // DNS events are only observed when code hotspots are enabled
    })
    const startTime = new Date()
    profiler.start()

    try {
      // This should match getMaxSamples() in events.js
      const factor = Math.max(1, Math.min(availableParallelism(), effectiveLibuvThreadCount)) + 2
      const expectedSampleCount = maxCpuSamples * factor
      const eventsToEmit = expectedSampleCount + 2 // Emit a few more to ensure the limit is enforced
      // Do 2 rounds to verify the limit is reset after each profiler.profile() call.
      for (let rounds = 0; rounds < 2; rounds++) {
        for (let i = 0; i < eventsToEmit; i++) {
          // Simulate a DNS lookup event
          const ctx = { args: ['example.com'] }
          startCh.publish(ctx)
          finishCh.publish(ctx)
        }
        const profile = toPprof(profiler, profiler.profile(true, startTime, new Date()))
        const sampleCount = profile.sample.length
        assert.equal(sampleCount, expectedSampleCount)
      }
    } finally {
      profiler.stop()
    }
  })

  it('captures async zlib events with operation label', () => {
    const profile = runOnceAndProfile(
      dc.channel('apm:zlib:operation:start'),
      dc.channel('apm:zlib:operation:finish'),
      { operation: 'gzip' }
    )
    assert.equal(profile.sample.length, 1)
    const labels = collectLabels(profile.sample[0], profile.stringTable)
    assert.equal(labels.event, 'zlib')
    assert.equal(labels.operation, 'gzip')
  })

  it('joins multiple GC reasons in their reported order', () => {
    let observerCallback
    /**
     * @param {import('node:perf_hooks').PerformanceObserverCallback} callback
     */
    function PerformanceObserver (callback) {
      observerCallback = callback
      return { disconnect: () => {}, observe: () => {} }
    }
    const StubbedEventsProfiler = proxyquire('../../../src/profiling/profilers/events', {
      perf_hooks: { constants, performance, PerformanceObserver },
    })
    const profiler = makeEvents(StubbedEventsProfiler, {
      flushInterval: 65_000,
      timelineSamplingEnabled: false,
      codeHotspotsEnabled: false,
    })
    const startTime = new Date()
    profiler.start()

    try {
      observerCallback({
        getEntries () {
          return [{
            entryType: 'gc',
            startTime: 0,
            duration: 1,
            detail: {
              kind: constants.NODE_PERFORMANCE_GC_MINOR,
              flags: constants.NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED |
                constants.NODE_PERFORMANCE_GC_FLAGS_FORCED,
            },
          }]
        },
      })
      const profile = toPprof(profiler, profiler.profile(true, startTime, new Date()))
      const labels = collectLabels(profile.sample[0], profile.stringTable)

      assert.equal(labels['gc reason'], 'construct_retained,forced')
    } finally {
      profiler.stop()
    }
  })

  it('builds timeline profiles of the period with a synthetic frame', () => {
    const startDate = new Date(1_000_000)
    const endDate = new Date(1_065_000)
    const profiler = makeEvents(EventsProfiler, {
      flushInterval: 65_000,
      timelineSamplingEnabled: false,
      codeHotspotsEnabled: true,
    })
    // Events are timed on the performance clock, which sinon's fake timers don't control for the
    // perf_hooks performance object that the event plugins hold: the event starts at 100 ms after
    // performance.timeOrigin, and finishes 5 ms later
    const now = sinon.stub(performance, 'now')
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(105)
    profiler.start()
    let captured
    try {
      const ctx = { operation: 'gzip' }
      dc.channel('apm:zlib:operation:start').publish(ctx)
      dc.channel('apm:zlib:operation:finish').publish(ctx)
      captured = profiler.profile(true, startDate, endDate)
    } finally {
      now.restore()
      profiler.stop()
    }
    const profile = toPprof(profiler, captured)
    const strings = profile.stringTable.strings
    const valueType = t => `${strings[t.type]}/${strings[t.unit]}`

    assert.deepStrictEqual(profile.sampleType.map(valueType), ['timeline/nanoseconds'])
    assert.strictEqual(valueType(profile.periodType), 'timeline/nanoseconds')
    assert.strictEqual(Number(profile.period), 1)
    assert.strictEqual(Number(profile.timeNanos), endDate.getTime() * 1_000_000)
    assert.strictEqual(Number(profile.durationNanos), 65_000 * 1_000_000)
    // One frame, whose name displays as blank
    assert.strictEqual(profile.location.length, 1)
    assert.deepStrictEqual(profile.function.map(f => strings[f.name]), [' '])
    // The sample's time is its end_timestamp_ns label
    const labels = collectLabels(profile.sample[0], profile.stringTable)
    assert.strictEqual(
      BigInt(labels.end_timestamp_ns),
      BigInt(Math.round(performance.timeOrigin * 1_000_000)) + 105_000_000n
    )
    // Its value is the event's duration
    assert.deepStrictEqual(profile.sample[0].value.map(Number), [5_000_000])
    // A captured profile can be visited again
    assert.deepStrictEqual(toPprof(profiler, captured).sample.length, 1)
  })

  for (const port of [8080, '8080']) {
    it(`labels net connections with their port as a number, given as a ${typeof port}`, () => {
      const profile = runOnceAndProfile(
        dc.channel('apm:net:tcp:start'),
        dc.channel('apm:net:tcp:finish'),
        { options: { host: 'localhost', port } }
      )
      assert.equal(profile.sample.length, 1)
      const portKey = profile.stringTable.dedup('port')
      const label = profile.sample[0].label.find(l => l.key === portKey)
      assert.ok(label)
      assert.strictEqual(Number(label.num), 8080)
      assert.strictEqual(Number(label.str), 0)
      const labels = collectLabels(profile.sample[0], profile.stringTable)
      assert.equal(labels.event, 'net')
      assert.equal(labels.operation, 'connect')
      assert.equal(labels.host, 'localhost')
    })
  }

  it('captures async crypto events with per-op labels', () => {
    const profile = runOnceAndProfile(
      dc.channel('apm:crypto:operation:start'),
      dc.channel('apm:crypto:operation:finish'),
      { operation: 'pbkdf2', digest: 'sha256', iterations: 1000, keylen: 32 }
    )
    assert.equal(profile.sample.length, 1)
    const labels = collectLabels(profile.sample[0], profile.stringTable)
    assert.equal(labels.event, 'crypto')
    assert.equal(labels.operation, 'pbkdf2')
    assert.equal(labels.digest, 'sha256')
    assert.equal(labels.iterations, 1000)
    assert.equal(labels.keylen, 32)
  })

  it('drops async crypto events with unexpected context fields', () => {
    const profile = runOnceAndProfile(
      dc.channel('apm:crypto:operation:start'),
      dc.channel('apm:crypto:operation:finish'),
      { operation: 'randomBytes', size: 16, password: 'secret', buffer: Buffer.alloc(0) }
    )
    assert.equal(profile.sample.length, 1)
    const labels = collectLabels(profile.sample[0], profile.stringTable)
    assert.equal(labels.operation, 'randomBytes')
    assert.equal(labels.size, 16)
    assert.equal(labels.password, undefined)
    assert.equal(labels.buffer, undefined)
  })
})

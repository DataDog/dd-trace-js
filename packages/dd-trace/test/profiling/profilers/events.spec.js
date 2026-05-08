'use strict'

const assert = require('node:assert')

const { afterEach, describe, it } = require('mocha')
const dc = require('dc-polyfill')

require('../../setup/core')
const { storage } = require('../../../../datadog-core')
const { getConfigFresh } = require('../../helpers/config')
const { availableParallelism, effectiveLibuvThreadCount } = require('../../../src/profiling/libuv-size')
const EventsProfiler = require('../../../src/profiling/profilers/events')

const startCh = dc.channel('apm:dns:lookup:start')
const finishCh = dc.channel('apm:dns:lookup:finish')

function collectLabels (sample, stringTable) {
  const labels = {}
  for (const label of sample.label) {
    const key = stringTable.strings[label.key]
    labels[key] = label.str ? stringTable.strings[label.str] : label.num
  }
  return labels
}

function runOnceAndProfile (startChannel, finishChannel, ctx) {
  const profiler = new EventsProfiler({
    samplingInterval: 10_000,
    flushInterval: 65_000,
    timelineSamplingEnabled: false,
    codeHotspotsEnabled: true,
  })
  const startTime = new Date()
  profiler.start()
  try {
    startChannel.publish(ctx)
    finishChannel.publish(ctx)
    return profiler.profile(true, startTime, new Date())()
  } finally {
    profiler.stop()
  }
}

function getProfilerConfig (tracerOptions) {
  const tracerConfig = getConfigFresh(tracerOptions)
  const ProfilingConfig = require('../../../src/profiling/config').Config
  return new ProfilingConfig({
    url: 'http://127.0.0.1:8126',
    ...tracerConfig,
  })
}

describe('profilers/events', () => {
  afterEach(() => {
    storage('legacy').enterWith(undefined)
  })

  it('should provide info', () => {
    const info = new EventsProfiler(getProfilerConfig()).getInfo()
    assert(info.maxSamples > 0)
  })

  it('should limit the number of events', async () => {
    const samplingInterval = 1
    const flushInterval = 2
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

    const profiler = new EventsProfiler({
      samplingInterval,
      flushInterval,
      timelineSamplingEnabled: false, // don't discard any events
      codeHotspotsEnabled: true, // DNS events are only observed when code hotspots are enabled
    })
    const startTime = new Date()
    profiler.start()

    try {
      // This should match getMaxSamples() in events.js
      const factor = Math.max(1, Math.min(availableParallelism(), effectiveLibuvThreadCount)) + 2
      const expectedSampleCount = flushInterval / samplingInterval * factor
      const eventsToEmit = expectedSampleCount + 2 // Emit a few more to ensure the limit is enforced
      // Do 2 rounds to verify the limit is reset after each profiler.profile() call.
      for (let rounds = 0; rounds < 2; rounds++) {
        for (let i = 0; i < eventsToEmit; i++) {
          // Simulate a DNS lookup event
          const ctx = { args: ['example.com'] }
          startCh.publish(ctx)
          finishCh.publish(ctx)
        }
        const profile = profiler.profile(true, startTime, new Date())()
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

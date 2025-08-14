'use strict'

require('../../setup/tap')

const assert = require('assert')
const dc = require('dc-polyfill')
const startCh = dc.channel('apm:dns:lookup:start')
const finishCh = dc.channel('apm:dns:lookup:finish')
const { storage } = require('../../../../datadog-core')
const { availableParallelism, effectiveLibuvThreadCount } = require('../../../src/profiling/libuv-size')
const EventsProfiler = require('../../../src/profiling/profilers/events')

describe('profilers/events', () => {
  it('should limit the number of events', async () => {
    const samplingInterval = 1
    const flushInterval = 2
    // Set up a mock span to simulate tracing context
    const span = {
      context: () => ({
        toBigIntSpanId: () => 1234n,
        _trace: {
          started: [span]
        }
      })
    }
    storage('legacy').enterWith({ span })

    const profiler = new EventsProfiler({
      samplingInterval,
      flushInterval,
      timelineSamplingEnabled: false, // don't discard any events
      codeHotspotsEnabled: true // DNS events are only observed when code hotspots are enabled
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
})

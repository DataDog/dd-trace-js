'use strict'

const assert = require('assert')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('sampling', function () {
    it('should respect sampling rate for single probe', function (done) {
      let prev, timer
      const rcConfig = t.generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })

      function triggerBreakpointContinuously () {
        t.request(t.breakpoint.url).catch(done)
        timer = setTimeout(triggerBreakpointContinuously, 10)
      }

      t.agent.on('debugger-diagnostics', ({ payload }) => {
        payload.forEach((event) => {
          if (event.debugger.diagnostics.status === 'INSTALLED') triggerBreakpointContinuously()
        })
      })

      t.agent.on('debugger-input', ({ payload }) => {
        payload.forEach(({ debugger: { snapshot: { timestamp } } }) => {
          const previousTimestamp = prev
          prev = timestamp
          if (previousTimestamp !== undefined) {
            const duration = timestamp - previousTimestamp
            clearTimeout(timer)

            // Snapshot timestamps use wall-clock time while sampling uses monotonic time, so allow 75ms for drift.
            assert.ok(duration >= 925, `duration (${duration}) should be >= 925`)
            assert.ok(duration < 1075, `duration (${duration}) should be < 1075`)

            // Wait at least a full sampling period, to see if we get any more payloads
            timer = setTimeout(() => done(), 1250)
          }
        })
      })

      t.agent.addRemoteConfig(rcConfig)
    })

    it('should adhere to individual probes sample rate', function (done) {
      /** @type {(() => void) & { calledOnce?: boolean }} */
      const doneWhenCalledTwice = () => {
        if (doneWhenCalledTwice.calledOnce) return done()
        doneWhenCalledTwice.calledOnce = true
      }

      const rcConfig1 = t.breakpoints[0].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
      const rcConfig2 = t.breakpoints[1].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
      const state = {
        [rcConfig1.config.id]: {
          triggerBreakpointContinuously () {
            t.request(t.breakpoints[0].url).catch(done)
            this.timer = setTimeout(this.triggerBreakpointContinuously.bind(this), 10)
          },
        },
        [rcConfig2.config.id]: {
          triggerBreakpointContinuously () {
            t.request(t.breakpoints[1].url).catch(done)
            this.timer = setTimeout(this.triggerBreakpointContinuously.bind(this), 10)
          },
        },
      }

      t.agent.on('debugger-diagnostics', ({ payload }) => {
        payload.forEach((event) => {
          const { probeId, status } = event.debugger.diagnostics
          if (status === 'INSTALLED') state[probeId].triggerBreakpointContinuously()
        })
      })

      t.agent.on('debugger-input', ({ payload }) => {
        payload.forEach((result) => {
          const _state = state[result.debugger.snapshot.probe.id]
          const { timestamp } = result.debugger.snapshot
          if (_state.prev !== undefined) {
            const duration = timestamp - _state.prev
            clearTimeout(_state.timer)

            // Snapshot timestamps use wall-clock time while sampling uses monotonic time, so allow 75ms for drift.
            assert.ok(duration >= 925, `duration (${duration}) should be >= 925`)
            assert.ok(duration < 1075, `duration (${duration}) should be < 1075`)

            // Wait at least a full sampling period, to see if we get any more payloads
            _state.timer = setTimeout(doneWhenCalledTwice, 1250)
          }
          _state.prev = timestamp
        })
      })

      t.agent.addRemoteConfig(rcConfig1)
      t.agent.addRemoteConfig(rcConfig2)
    })
  })
})

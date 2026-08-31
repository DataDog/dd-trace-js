'use strict'

const assert = require('node:assert/strict')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('sampling', function () {
    it('should respect sampling rate for single probe', function () {
      return new Promise((resolve, reject) => {
        let previousTimestamp, timer
        const rcConfig = t.generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })

        function triggerBreakpointContinuously () {
          t.axios.get(t.breakpoint.url).catch(finish)
          timer = setTimeout(triggerBreakpointContinuously, 10)
        }

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            if (event.debugger.diagnostics.status === 'INSTALLED') triggerBreakpointContinuously()
          })
        })

        t.agent.on('debugger-input', ({ payload }) => {
          try {
            payload.forEach(({ debugger: { snapshot: { timestamp } } }) => {
              const lastTimestamp = previousTimestamp
              previousTimestamp = timestamp
              if (lastTimestamp !== undefined) {
                const duration = timestamp - lastTimestamp
                clearTimeout(timer)

                // Snapshot timestamps use wall-clock time while sampling uses monotonic time, so allow 75ms for drift.
                assert.ok(duration >= 925, `duration (${duration}) should be >= 925`)
                assert.ok(duration < 1075, `duration (${duration}) should be < 1075`)

                // Wait at least a full sampling period, to see if we get any more payloads
                timer = setTimeout(finish, 1250)
              }
            })
          } catch (error) {
            finish(error)
          }
        })

        t.agent.addRemoteConfig(rcConfig)

        /** @param {Error} [error] */
        function finish (error) {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
      })
    })

    it('should adhere to individual probes sample rate', function () {
      return new Promise((resolve, reject) => {
        let quietPeriods = 0
        const rcConfig1 = t.breakpoints[0].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
        const rcConfig2 = t.breakpoints[1].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
        const state = {
          [rcConfig1.config.id]: {
            triggerBreakpointContinuously () {
              t.axios.get(t.breakpoints[0].url).catch(finish)
              this.timer = setTimeout(this.triggerBreakpointContinuously.bind(this), 10)
            },
          },
          [rcConfig2.config.id]: {
            triggerBreakpointContinuously () {
              t.axios.get(t.breakpoints[1].url).catch(finish)
              this.timer = setTimeout(this.triggerBreakpointContinuously.bind(this), 10)
            },
          },
        }

        function observeQuietPeriod () {
          if (++quietPeriods === 2) finish()
        }

        /** @param {Error} [error] */
        function finish (error) {
          clearTimeout(state[rcConfig1.config.id].timer)
          clearTimeout(state[rcConfig2.config.id].timer)
          if (error) reject(error)
          else resolve()
        }

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            const { probeId, status } = event.debugger.diagnostics
            if (status === 'INSTALLED') state[probeId].triggerBreakpointContinuously()
          })
        })

        t.agent.on('debugger-input', ({ payload }) => {
          try {
            payload.forEach((result) => {
              const probeState = state[result.debugger.snapshot.probe.id]
              const { timestamp } = result.debugger.snapshot
              if (probeState.previousTimestamp !== undefined) {
                const duration = timestamp - probeState.previousTimestamp
                clearTimeout(probeState.timer)

                // Snapshot timestamps use wall-clock time while sampling uses monotonic time, so allow 75ms for drift.
                assert.ok(duration >= 925, `duration (${duration}) should be >= 925`)
                assert.ok(duration < 1075, `duration (${duration}) should be < 1075`)

                // Wait at least a full sampling period, to see if we get any more payloads
                probeState.timer = setTimeout(observeQuietPeriod, 1250)
              }
              probeState.previousTimestamp = timestamp
            })
          } catch (error) {
            finish(error)
          }
        })

        t.agent.addRemoteConfig(rcConfig1)
        t.agent.addRemoteConfig(rcConfig2)
      })
    })
  })
})

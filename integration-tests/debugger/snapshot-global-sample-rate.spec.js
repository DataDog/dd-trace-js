'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({
    testApp: 'target-app/basic.js',
    dependencies: ['fastify']
  })

  describe('input messages', function () {
    describe('with snapshot', function () {
      beforeEach(t.triggerBreakpoint)

      it('should respect global max snapshot sampling rate', function (_done) {
        const MAX_SNAPSHOTS_PER_SECOND_GLOBALLY = 25
        const snapshotsPerSecond = MAX_SNAPSHOTS_PER_SECOND_GLOBALLY * 2
        const probeConf = { captureSnapshot: true, sampling: { snapshotsPerSecond } }
        let start = 0
        let hitBreakpoints = 0
        let isDone = false
        let prevTimestamp

        const rcConfig1 = t.breakpoints[0].generateRemoteConfig(probeConf)
        const rcConfig2 = t.breakpoints[1].generateRemoteConfig(probeConf)

        // Two breakpoints, each triggering a request every 10ms, so we should get 200 requests per second
        const state = {
          [rcConfig1.config.id]: {
            tiggerBreakpointContinuously () {
              t.axios.get(t.breakpoints[0].url).catch(done)
              this.timer = setTimeout(this.tiggerBreakpointContinuously.bind(this), 10)
            }
          },
          [rcConfig2.config.id]: {
            tiggerBreakpointContinuously () {
              t.axios.get(t.breakpoints[1].url).catch(done)
              this.timer = setTimeout(this.tiggerBreakpointContinuously.bind(this), 10)
            }
          }
        }

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            const { probeId, status } = event.debugger.diagnostics
            if (status === 'INSTALLED') {
              state[probeId].tiggerBreakpointContinuously()
            }
          })
        })

        t.agent.on('debugger-input', ({ payload }) => {
          payload.forEach(({ debugger: { snapshot: { timestamp } } }) => {
            if (isDone) return
            if (start === 0) start = timestamp
            if (++hitBreakpoints <= MAX_SNAPSHOTS_PER_SECOND_GLOBALLY) {
              prevTimestamp = timestamp
            } else {
              const duration = timestamp - start
              const timeSincePrevTimestamp = timestamp - prevTimestamp

              // Allow for a time variance (time will tell if this is enough). Timeouts can vary.
              assert.isAtLeast(duration, 925)
              assert.isBelow(duration, 1050)

              // A sanity check to make sure we're not saturating the event loop. We expect a lot of snapshots to be
              // sampled in the beginning of the sample window and then once the threshold is hit, we expect a "quiet"
              // period until the end of the window. If there's no "quiet" period, then we're saturating the event loop
              // and this test isn't really testing anything.
              assert.isAtLeast(timeSincePrevTimestamp, 250)

              clearTimeout(state[rcConfig1.config.id].timer)
              clearTimeout(state[rcConfig2.config.id].timer)

              done()
            }
          })
        })

        t.agent.addRemoteConfig(rcConfig1)
        t.agent.addRemoteConfig(rcConfig2)

        function done (err) {
          if (isDone) return
          isDone = true
          _done(err)
        }
      })
    })
  })
})

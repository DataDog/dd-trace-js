'use strict'

const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('race conditions', function () {
    it('should remove the last breakpoint completely before trying to add a new one', function (done) {
      const rcConfig2 = t.generateRemoteConfig()

      t.agent.on('debugger-diagnostics', ({ payload }) => {
        payload.forEach((event) => {
          const { probeId, status } = event.debugger.diagnostics
          if (status !== 'INSTALLED') return

          if (probeId === t.rcConfig.config.id) {
            // First INSTALLED payload: Try to trigger the race condition.
            t.agent.removeRemoteConfig(t.rcConfig.id)
            t.agent.addRemoteConfig(rcConfig2)
          } else {
            // Second INSTALLED payload: Perform an HTTP request to see if we successfully handled the race condition.
            let finished = false

            // If the race condition occurred, the debugger will have been detached from the main thread and the new
            // probe will never trigger. If that's the case, the following timer will fire:
            const timer = setTimeout(() => {
              done(new Error('Race condition occurred!'))
            }, 2000)

            // If we successfully handled the race condition, the probe will trigger, we'll get a probe result and the
            // following event listener will be called:
            t.agent.once('debugger-input', () => {
              clearTimeout(timer)
              finished = true
              done()
            })

            // Perform HTTP request to try and trigger the probe
            t.axios.get(t.breakpoint.url).catch((err) => {
              // If the request hasn't fully completed by the time the tests ends and the target app is destroyed,
              // Axios will complain with a "socket hang up" error. Hence this sanity check before calling
              // `done(err)`. If we later add more tests below this one, this shouldn't be an issue.
              if (!finished) done(err)
            })
          }
        })
      })

      t.agent.addRemoteConfig(t.rcConfig)
    })
  })
})

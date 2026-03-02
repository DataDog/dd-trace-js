'use strict'

const assert = require('assert')
const { pollInterval, setup, testBasicInput } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('input messages', function () {
    it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))

    it('should respond with updated message if probe message is updated', function (done) {
      const expectedMessages = ['Hello World!', 'Hello Updated World!']
      const triggers = [
        async () => {
          await t.axios.get(t.breakpoint.url)
          t.rcConfig.config.version++
          t.rcConfig.config.template = 'Hello Updated World!'
          t.agent.updateRemoteConfig(t.rcConfig.id, t.rcConfig.config)
        },
        async () => {
          await t.axios.get(t.breakpoint.url)
        },
      ]

      t.agent.on('debugger-diagnostics', ({ payload }) => {
        payload.forEach((event) => {
          if (event.debugger.diagnostics.status === 'INSTALLED') {
            const trigger = triggers.shift()
            assert.ok(trigger, 'expecting a trigger function to be defined')
            trigger().catch(done)
          }
        })
      })

      t.agent.on('debugger-input', ({ payload: [payload] }) => {
        assert.strictEqual(payload.message, expectedMessages.shift())
        if (expectedMessages.length === 0) done()
      })

      t.agent.addRemoteConfig(t.rcConfig)
    })

    it('should not trigger if probe is deleted', function (done) {
      t.agent.on('debugger-diagnostics', ({ payload }) => {
        payload.forEach((event) => {
          if (event.debugger.diagnostics.status === 'INSTALLED') {
            t.agent.once('remote-config-responded', async () => {
              await t.axios.get(t.breakpoint.url)
              // We want to wait enough time to see if the client triggers on the breakpoint so that the test can fail
              // if it does, but not so long that the test times out.
              // TODO: Is there some signal we can use instead of a timer?
              setTimeout(done, pollInterval * 2 * 1000) // wait twice as long as the RC poll interval
            })

            t.agent.removeRemoteConfig(t.rcConfig.id)
          }
        })
      })

      t.agent.on('debugger-input', () => {
        assert.fail('should not capture anything when the probe is deleted')
      })

      t.agent.addRemoteConfig(t.rcConfig)
    })
  })
})

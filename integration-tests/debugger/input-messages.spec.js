'use strict'

const assert = require('assert')
const { on, once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')

const { pollInterval, setup, testBasicInput } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('input messages', function () {
    it('should capture and send expected payload when a log line probe is triggered', testBasicInput.bind(null, t))

    it('should respond with updated message if probe message is updated', async function () {
      const expectedMessages = ['Hello World!', 'Hello Updated World!']
      const receivedMessages = []

      /** @param {{ payload: Array<{ message: string }> }} event */
      function collectMessages ({ payload }) {
        for (const { message } of payload) receivedMessages.push(message)
      }
      t.agent.on('debugger-input', collectMessages)

      try {
        const firstInput = once(t.agent, 'debugger-input')
        const firstTrigger = t.triggerBreakpoint()
        t.agent.addRemoteConfig(t.rcConfig)
        await Promise.all([firstTrigger, firstInput])

        t.rcConfig.config.version++
        t.rcConfig.config.template = 'Hello Updated World!'
        const secondInput = once(t.agent, 'debugger-input')
        const secondTrigger = t.triggerBreakpoint()
        t.agent.updateRemoteConfig(t.rcConfig.id, t.rcConfig.config)
        await Promise.all([secondTrigger, secondInput])
        await delay(pollInterval * 2 * 1000)
      } finally {
        t.agent.removeListener('debugger-input', collectMessages)
      }

      assert.deepStrictEqual(receivedMessages, expectedMessages)
    })

    it('should not trigger if probe is deleted', async function () {
      const diagnostics = on(t.agent, 'debugger-diagnostics')
      let inputCount = 0
      const countInput = () => inputCount++
      t.agent.on('debugger-input', countInput)

      try {
        t.agent.addRemoteConfig(t.rcConfig)
        for await (const [{ payload }] of diagnostics) {
          if (payload.some(event => event.debugger.diagnostics.status === 'INSTALLED')) break
        }

        const configRemoved = once(t.agent, 'remote-config-responded')
        t.agent.removeRemoteConfig(t.rcConfig.id)
        await configRemoved
        await t.axios.get(t.breakpoint.url)
        await delay(pollInterval * 2 * 1000)
      } finally {
        t.agent.removeListener('debugger-input', countInput)
      }

      assert.strictEqual(inputCount, 0)
    })
  })
})

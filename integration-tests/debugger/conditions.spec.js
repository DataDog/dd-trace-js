'use strict'

const assert = require('assert')
const { once } = require('node:events')

const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('condition', function () {
    beforeEach(() => { t.triggerBreakpoint() })

    /**
     * @param {string} expectedStatus
     * @returns {Promise<object[]>}
     */
    function waitForDiagnosticsStatus (expectedStatus) {
      return new Promise(resolve => {
        t.agent.on('debugger-diagnostics', function onDiagnostics ({ payload }) {
          if (payload.some(event => event.debugger.diagnostics.status === expectedStatus)) {
            t.agent.removeListener('debugger-diagnostics', onDiagnostics)
            resolve(payload)
          }
        })
      })
    }

    it('should trigger when condition is met', async function () {
      const inputPromise = once(t.agent, 'debugger-input')
      t.agent.addRemoteConfig(t.generateRemoteConfig({
        when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } },
      }))

      await inputPromise
    })

    it('should not trigger when condition is not met', async function () {
      t.agent.on('debugger-input', () => {
        assert.fail('Should not trigger when condition is not met')
      })

      const installedPromise = waitForDiagnosticsStatus('INSTALLED')
      t.agent.addRemoteConfig(t.generateRemoteConfig({
        when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } },
      }))

      await installedPromise

      // Can't know if the probe did not trigger, so wait briefly and fail if input arrives in the meantime.
      await new Promise(resolve => setTimeout(resolve, 2000))
    })

    it('should report error if condition cannot be compiled', async function () {
      const rcConfig = t.generateRemoteConfig({
        when: { dsl: 'original dsl', json: { ref: 'this is not a valid ref' } },
      })

      const errorPromise = waitForDiagnosticsStatus('ERROR')
      t.agent.addRemoteConfig(rcConfig)

      const payload = await errorPromise
      const diagnostics = payload.map(event => event.debugger.diagnostics)
      const error = diagnostics.find(({ status }) => status === 'ERROR')
      assert.ok(error)
      assert.strictEqual(
        error.exception.message,
        `Cannot compile expression: original dsl (probe: ${rcConfig.config.id}, version: 0)`
      )
      assert.ok(!diagnostics.some(({ status }) => status === 'INSTALLED'))
    })
  })
})

'use strict'

const assert = require('assert')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('condition', function () {
    beforeEach(() => { t.triggerBreakpoint() })

    it('should trigger when condition is met', function (done) {
      t.agent.on('debugger-input', () => {
        done()
      })

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } },
      }))
    })

    it('should not trigger when condition is not met', function (done) {
      t.agent.on('debugger-diagnostics', ({ payload }) => {
        payload.forEach((event) => {
          if (event.debugger.diagnostics.status === 'INSTALLED') {
            // Can't know if the probe didn't trigger, so just wait a bit and see if the test fails in the mean time
            setTimeout(done, 2000)
          }
        })
      })

      t.agent.on('debugger-input', () => {
        assert.fail('Should not trigger when condition is not met')
      })

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } },
      }))
    })

    it('should report error if condition cannot be compiled', function (done) {
      const rcConfig = t.generateRemoteConfig({
        when: { dsl: 'original dsl', json: { ref: 'this is not a valid ref' } },
      })

      t.agent.on('debugger-diagnostics', ({ payload }) => {
        payload.forEach(({ debugger: { diagnostics } }) => {
          if (diagnostics.status === 'ERROR') {
            assert.strictEqual(
              diagnostics.exception.message,
              `Cannot compile expression: original dsl (probe: ${rcConfig.config.id}, version: 0)`
            )
            done()
          } else if (diagnostics.status === 'INSTALLED') {
            assert.fail('Should not install when condition cannot be compiled')
          }
        })
      })

      t.agent.addRemoteConfig(rcConfig)
    })
  })
})

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

    it('should report an error result if the condition throws, once per throttle window', function (done) {
      const rcConfig = t.generateRemoteConfig({
        captureSnapshot: true,
        when: { dsl: 'definitelyDoesNotExist == "never"', json: { eq: [{ ref: 'definitelyDoesNotExist' }, 'never'] } },
      })
      let results = 0

      t.agent.on('debugger-input', ({ payload }) => {
        results += payload.length
        assert.strictEqual(payload.length, 1)
        const { message, debugger: { snapshot } } = payload[0]

        assert.strictEqual(message, 'ReferenceError: definitelyDoesNotExist is not defined')
        assert.deepStrictEqual(snapshot.evaluationErrors, [{
          expr: 'definitelyDoesNotExist == "never"',
          message: 'ReferenceError: definitelyDoesNotExist is not defined',
        }])
        assert.strictEqual(snapshot.captures, undefined, 'should not capture anything for a failing condition')
        assert.strictEqual(snapshot.probe.id, rcConfig.config.id)

        // Every further hit within the throttle window is skipped without evaluating the condition again
        Promise.all([t.request(t.breakpoint.url), t.request(t.breakpoint.url)])
          .then(() => new Promise((resolve) => setTimeout(resolve, 1500)))
          .then(() => {
            assert.strictEqual(results, 1, 'should only report the condition error once')
            done()
          })
          .catch(done)
      })

      t.agent.addRemoteConfig(rcConfig)
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

'use strict'

const os = require('os')

const { assert } = require('chai')
const { pollInterval, setup } = require('./utils')
const { assertObjectContains, assertUUID } = require('../helpers')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('../../packages/dd-trace/src/remote_config/apply_states')
const { version } = require('../../package.json')

describe('Dynamic Instrumentation', function () {
  describe('Default env', function () {
    const t = setup({ dependencies: ['fastify'] })

    it('base case: target app should work as expected if no test probe has been added', async function () {
      const response = await t.axios.get(t.breakpoint.url)
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'bar' })
    })

    describe('diagnostics messages', function () {
      it('should send expected diagnostics messages if probe is received and triggered', function (done) {
        let receivedAckUpdate = false
        const probeId = t.rcConfig.config.id
        const expectedPayloads = [{
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 0, status: 'RECEIVED' } }
        }, {
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 0, status: 'INSTALLED' } }
        }, {
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 0, status: 'EMITTING' } }
        }]

        t.agent.on('remote-config-ack-update', (id, version, state, error) => {
          // Due to the very short DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS, there's a race condition in which we might
          // get an UNACKNOWLEDGED state first before the ACKNOWLEDGED state.
          if (state === UNACKNOWLEDGED) return

          assert.strictEqual(id, t.rcConfig.id)
          assert.strictEqual(version, 1)
          assert.strictEqual(state, ACKNOWLEDGED)
          assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

          receivedAckUpdate = true
          endIfDone()
        })

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            const expected = expectedPayloads.shift()
            assertObjectContains(event, expected)
            assertUUID(event.debugger.diagnostics.runtimeId)

            if (event.debugger.diagnostics.status === 'INSTALLED') {
              t.axios.get(t.breakpoint.url)
                .then((response) => {
                  assert.strictEqual(response.status, 200)
                  assert.deepStrictEqual(response.data, { hello: 'bar' })
                })
                .catch(done)
            } else {
              endIfDone()
            }
          })
        })

        t.agent.addRemoteConfig(t.rcConfig)

        function endIfDone () {
          if (receivedAckUpdate && expectedPayloads.length === 0) done()
        }
      })

      it('should send expected diagnostics messages if probe is first received and then updated', function (done) {
        let receivedAckUpdates = 0
        const probeId = t.rcConfig.config.id
        const expectedPayloads = [{
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 0, status: 'RECEIVED' } }
        }, {
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 0, status: 'INSTALLED' } }
        }, {
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 1, status: 'RECEIVED' } }
        }, {
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 1, status: 'INSTALLED' } }
        }]
        const triggers = [
          () => {
            t.rcConfig.config.version++
            t.agent.updateRemoteConfig(t.rcConfig.id, t.rcConfig.config)
          },
          () => {}
        ]

        t.agent.on('remote-config-ack-update', (id, version, state, error) => {
          // Due to the very short DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS, there's a race condition in which we might
          // get an UNACKNOWLEDGED state first before the ACKNOWLEDGED state.
          if (state === UNACKNOWLEDGED) return

          assert.strictEqual(id, t.rcConfig.id)
          assert.strictEqual(version, ++receivedAckUpdates)
          assert.strictEqual(state, ACKNOWLEDGED)
          assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

          endIfDone()
        })

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            const expected = expectedPayloads.shift()
            assertObjectContains(event, expected)
            assertUUID(event.debugger.diagnostics.runtimeId)
            if (event.debugger.diagnostics.status === 'INSTALLED') triggers.shift()()
            endIfDone()
          })
        })

        t.agent.addRemoteConfig(t.rcConfig)

        function endIfDone () {
          if (receivedAckUpdates === 2 && expectedPayloads.length === 0) done()
        }
      })

      it('should send expected diagnostics messages if probe is first received and then deleted', function (done) {
        let receivedAckUpdate = false
        let payloadsProcessed = false
        const probeId = t.rcConfig.config.id
        const expectedPayloads = [{
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 0, status: 'RECEIVED' } }
        }, {
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { probeId, probeVersion: 0, status: 'INSTALLED' } }
        }]

        t.agent.on('remote-config-ack-update', (id, version, state, error) => {
          // Due to the very short DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS, there's a race condition in which we might
          // get an UNACKNOWLEDGED state first before the ACKNOWLEDGED state.
          if (state === UNACKNOWLEDGED) return

          assert.strictEqual(id, t.rcConfig.id)
          assert.strictEqual(version, 1)
          assert.strictEqual(state, ACKNOWLEDGED)
          assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

          receivedAckUpdate = true
          endIfDone()
        })

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            const expected = expectedPayloads.shift()
            assertObjectContains(event, expected)
            assertUUID(event.debugger.diagnostics.runtimeId)

            if (event.debugger.diagnostics.status === 'INSTALLED') {
              t.agent.removeRemoteConfig(t.rcConfig.id)
              // Wait a little to see if we get any follow-up `debugger-diagnostics` messages
              setTimeout(() => {
                payloadsProcessed = true
                endIfDone()
              }, pollInterval * 2 * 1000) // wait twice as long as the RC poll interval
            }
          })
        })

        t.agent.addRemoteConfig(t.rcConfig)

        function endIfDone () {
          if (receivedAckUpdate && payloadsProcessed) done()
        }
      })

      it(
        'should send expected error diagnostics messages if probe doesn\'t conform to expected schema',
        unsupporedOrInvalidProbesTest('bad config!!!', { status: 'ERROR' })
      )

      it(
        'should send expected error diagnostics messages if probe type isn\'t supported',
        unsupporedOrInvalidProbesTest(t.generateProbeConfig({ type: 'INVALID_PROBE' }))
      )

      it(
        'should send expected error diagnostics messages if it isn\'t a line-probe',
        unsupporedOrInvalidProbesTest(
          t.generateProbeConfig({ where: { typeName: 'index.js', methodName: 'handlerA' } })
        )
      )

      function unsupporedOrInvalidProbesTest (config, customErrorDiagnosticsObj) {
        return function (done) {
          let receivedAckUpdate = false

          t.agent.on('remote-config-ack-update', (id, version, state, error) => {
            assert.strictEqual(id, `logProbe_${config.id}`)
            assert.strictEqual(version, 1)
            assert.strictEqual(state, ERROR)
            assert.strictEqual(error.slice(0, 6), 'Error:')

            receivedAckUpdate = true
            endIfDone()
          })

          const probeId = config.id
          const expectedPayloads = [{
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { diagnostics: { status: 'RECEIVED' } }
          }, {
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { diagnostics: customErrorDiagnosticsObj ?? { probeId, probeVersion: 0, status: 'ERROR' } }
          }]

          t.agent.on('debugger-diagnostics', ({ payload }) => {
            payload.forEach((event) => {
              const expected = expectedPayloads.shift()
              assertObjectContains(event, expected)
              const { diagnostics } = event.debugger
              assertUUID(diagnostics.runtimeId)

              if (diagnostics.status === 'ERROR') {
                assert.property(diagnostics, 'exception')
                assert.hasAllKeys(diagnostics.exception, ['message', 'stacktrace'])
                assert.typeOf(diagnostics.exception.message, 'string')
                assert.typeOf(diagnostics.exception.stacktrace, 'string')
              }

              endIfDone()
            })
          })

          t.agent.addRemoteConfig({
            product: 'LIVE_DEBUGGING',
            id: `logProbe_${config.id}`,
            config
          })

          function endIfDone () {
            if (receivedAckUpdate && expectedPayloads.length === 0) done()
          }
        }
      }

      describe('multiple probes at the same location', function () {
        it('should support adding multiple probes at the same location', function (done) {
          const rcConfig1 = t.generateRemoteConfig()
          const rcConfig2 = t.generateRemoteConfig()
          const expectedPayloads = [{
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { diagnostics: { probeId: rcConfig1.config.id, probeVersion: 0, status: 'RECEIVED' } }
          }, {
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { diagnostics: { probeId: rcConfig2.config.id, probeVersion: 0, status: 'RECEIVED' } }
          }, {
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { diagnostics: { probeId: rcConfig1.config.id, probeVersion: 0, status: 'INSTALLED' } }
          }, {
            ddsource: 'dd_debugger',
            service: 'node',
            debugger: { diagnostics: { probeId: rcConfig2.config.id, probeVersion: 0, status: 'INSTALLED' } }
          }]

          t.agent.on('debugger-diagnostics', ({ payload }) => {
            payload.forEach((event) => {
              const expected = expectedPayloads.shift()
              assertObjectContains(event, expected)
            })
            endIfDone()
          })

          t.agent.addRemoteConfig(rcConfig1)
          t.agent.addRemoteConfig(rcConfig2)

          function endIfDone () {
            if (expectedPayloads.length === 0) done()
          }
        })

        it('should support triggering multiple probes added at the same location', function (done) {
          let installed = 0
          const rcConfig1 = t.generateRemoteConfig()
          const rcConfig2 = t.generateRemoteConfig()
          const expectedPayloads = new Map([
            [rcConfig1.config.id, {
              ddsource: 'dd_debugger',
              service: 'node',
              debugger: { diagnostics: { probeId: rcConfig1.config.id, probeVersion: 0, status: 'EMITTING' } }
            }],
            [rcConfig2.config.id, {
              ddsource: 'dd_debugger',
              service: 'node',
              debugger: { diagnostics: { probeId: rcConfig2.config.id, probeVersion: 0, status: 'EMITTING' } }
            }]
          ])

          t.agent.on('debugger-diagnostics', ({ payload }) => {
            payload.forEach((event) => {
              const { diagnostics } = event.debugger
              if (diagnostics.status === 'INSTALLED') {
                if (++installed === 2) {
                  t.axios.get(t.breakpoint.url).catch(done)
                }
              } else if (diagnostics.status === 'EMITTING') {
                const expected = expectedPayloads.get(diagnostics.probeId)
                assert.ok(expected, `expected payload not found for probe ${diagnostics.probeId}`)
                expectedPayloads.delete(diagnostics.probeId)
                assertObjectContains(event, expected)
              }
            })
            endIfDone()
          })

          t.agent.addRemoteConfig(rcConfig1)
          t.agent.addRemoteConfig(rcConfig2)

          function endIfDone () {
            if (expectedPayloads.size === 0) done()
          }
        })

        it('should support not triggering any probes when all conditions are not met', function (done) {
          let installed = 0
          const rcConfig1 = t.generateRemoteConfig({ when: { json: { eq: [{ ref: 'foo' }, 'bar'] } } })
          const rcConfig2 = t.generateRemoteConfig({ when: { json: { eq: [{ ref: 'foo' }, 'baz'] } } })

          t.agent.on('debugger-diagnostics', ({ payload }) => {
            payload.forEach((event) => {
              const { diagnostics } = event.debugger
              if (diagnostics.status === 'INSTALLED') {
                if (++installed === 2) {
                  t.axios.get(t.breakpoint.url).catch(done)
                  setTimeout(done, 2000)
                }
              } else if (diagnostics.status === 'EMITTING') {
                assert.fail('should not trigger any probes when all conditions are not met')
              }
            })
          })

          t.agent.addRemoteConfig(rcConfig1)
          t.agent.addRemoteConfig(rcConfig2)
        })

        it('should only trigger the probes whos conditions are met (all have conditions)', function (done) {
          let installed = 0
          const rcConfig1 = t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } }
          })
          const rcConfig2 = t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } }
          })
          const expectedPayloads = new Map([
            [rcConfig2.config.id, {
              ddsource: 'dd_debugger',
              service: 'node',
              debugger: { diagnostics: { probeId: rcConfig2.config.id, probeVersion: 0, status: 'EMITTING' } }
            }]
          ])

          t.agent.on('debugger-diagnostics', ({ payload }) => {
            payload.forEach((event) => {
              const { diagnostics } = event.debugger
              if (diagnostics.status === 'INSTALLED') {
                if (++installed === 2) {
                  t.axios.get(t.breakpoint.url).catch(done)
                }
              } else if (diagnostics.status === 'EMITTING') {
                const expected = expectedPayloads.get(diagnostics.probeId)
                assert.ok(expected, `expected payload not found for probe ${diagnostics.probeId}`)
                expectedPayloads.delete(diagnostics.probeId)
                assertObjectContains(event, expected)
              }
            })
            endIfDone()
          })

          t.agent.addRemoteConfig(rcConfig1)
          t.agent.addRemoteConfig(rcConfig2)

          function endIfDone () {
            if (expectedPayloads.size === 0) done()
          }
        })

        it('trigger on met condition, even if other condition throws (all have conditions)', function (done) {
          let installed = 0
          // this condition will throw because `foo` is not defined
          const rcConfig1 = t.generateRemoteConfig({ when: { json: { eq: [{ ref: 'foo' }, 'bar'] } } })
          const rcConfig2 = t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } }
          })
          const expectedPayloads = new Map([
            [rcConfig2.config.id, {
              ddsource: 'dd_debugger',
              service: 'node',
              debugger: { diagnostics: { probeId: rcConfig2.config.id, probeVersion: 0, status: 'EMITTING' } }
            }]
          ])

          t.agent.on('debugger-diagnostics', ({ payload }) => {
            payload.forEach((event) => {
              const { diagnostics } = event.debugger
              if (diagnostics.status === 'INSTALLED') {
                if (++installed === 2) {
                  t.axios.get(t.breakpoint.url).catch(done)
                }
              } else if (diagnostics.status === 'EMITTING') {
                const expected = expectedPayloads.get(diagnostics.probeId)
                assert.ok(expected, `expected payload not found for probe ${diagnostics.probeId}`)
                expectedPayloads.delete(diagnostics.probeId)
                assertObjectContains(event, expected)
              }
            })
            endIfDone()
          })

          t.agent.addRemoteConfig(rcConfig1)
          t.agent.addRemoteConfig(rcConfig2)

          function endIfDone () {
            if (expectedPayloads.size === 0) done()
          }
        })

        it('should only trigger the probes whos conditions are met (not all have conditions)', function (done) {
          let installed = 0
          const rcConfig1 = t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } }
          })
          const rcConfig2 = t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } }
          })
          const rcConfig3 = t.generateRemoteConfig()
          const expectedPayloads = new Map([
            [rcConfig2.config.id, {
              ddsource: 'dd_debugger',
              service: 'node',
              debugger: { diagnostics: { probeId: rcConfig2.config.id, probeVersion: 0, status: 'EMITTING' } }
            }],
            [rcConfig3.config.id, {
              ddsource: 'dd_debugger',
              service: 'node',
              debugger: { diagnostics: { probeId: rcConfig3.config.id, probeVersion: 0, status: 'EMITTING' } }
            }]
          ])

          t.agent.on('debugger-diagnostics', ({ payload }) => {
            payload.forEach((event) => {
              const { diagnostics } = event.debugger
              if (diagnostics.status === 'INSTALLED') {
                if (++installed === 3) {
                  t.axios.get(t.breakpoint.url).catch(done)
                }
              } else if (diagnostics.status === 'EMITTING') {
                const expected = expectedPayloads.get(diagnostics.probeId)
                assert.ok(expected, `expected payload not found for probe ${diagnostics.probeId}`)
                expectedPayloads.delete(diagnostics.probeId)
                assertObjectContains(event, expected)
              }
            })
            endIfDone()
          })

          t.agent.addRemoteConfig(rcConfig1)
          t.agent.addRemoteConfig(rcConfig2)
          t.agent.addRemoteConfig(rcConfig3)

          function endIfDone () {
            if (expectedPayloads.size === 0) done()
          }
        })
      })
    })

    describe('input messages', function () {
      it(
        'should capture and send expected payload when a log line probe is triggered',
        testBasicInputWithDD.bind(null, t)
      )

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
          }
        ]

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            if (event.debugger.diagnostics.status === 'INSTALLED') triggers.shift()().catch(done)
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
              t.agent.once('remote-confg-responded', async () => {
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

    describe('sampling', function () {
      it('should respect sampling rate for single probe', function (done) {
        let prev, timer
        const rcConfig = t.generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })

        function triggerBreakpointContinuously () {
          t.axios.get(t.breakpoint.url).catch(done)
          timer = setTimeout(triggerBreakpointContinuously, 10)
        }

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            if (event.debugger.diagnostics.status === 'INSTALLED') triggerBreakpointContinuously()
          })
        })

        t.agent.on('debugger-input', ({ payload }) => {
          payload.forEach(({ debugger: { snapshot: { timestamp } } }) => {
            if (prev !== undefined) {
              const duration = timestamp - prev
              clearTimeout(timer)

              // Allow for a variance of +50ms (time will tell if this is enough)
              assert.isAtLeast(duration, 1000)
              assert.isBelow(duration, 1050)

              // Wait at least a full sampling period, to see if we get any more payloads
              timer = setTimeout(done, 1250)
            }
            prev = timestamp
          })
        })

        t.agent.addRemoteConfig(rcConfig)
      })

      it('should adhere to individual probes sample rate', function (done) {
        const rcConfig1 = t.breakpoints[0].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
        const rcConfig2 = t.breakpoints[1].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
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
            if (status === 'INSTALLED') state[probeId].tiggerBreakpointContinuously()
          })
        })

        t.agent.on('debugger-input', ({ payload }) => {
          payload.forEach((result) => {
            const _state = state[result.debugger.snapshot.probe.id]
            const { timestamp } = result.debugger.snapshot
            if (_state.prev !== undefined) {
              const duration = timestamp - _state.prev
              clearTimeout(_state.timer)

              // Allow for a variance of +50ms (time will tell if this is enough)
              assert.isAtLeast(duration, 1000)
              assert.isBelow(duration, 1050)

              // Wait at least a full sampling period, to see if we get any more payloads
              _state.timer = setTimeout(doneWhenCalledTwice, 1250)
            }
            _state.prev = timestamp
          })
        })

        t.agent.addRemoteConfig(rcConfig1)
        t.agent.addRemoteConfig(rcConfig2)

        function doneWhenCalledTwice () {
          if (doneWhenCalledTwice.calledOnce) return done()
          doneWhenCalledTwice.calledOnce = true
        }
      })
    })

    describe('condition', function () {
      beforeEach(t.triggerBreakpoint)

      it('should trigger when condition is met', function (done) {
        t.agent.on('debugger-input', () => {
          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({
          when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } }
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
          when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } }
        }))
      })

      it('should report error if condition cannot be compiled', function (done) {
        const rcConfig = t.generateRemoteConfig({
          when: { dsl: 'original dsl', json: { ref: 'this is not a valid ref' } }
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
                // `done(err)`. If we later add more tests below this one, this shouuldn't be an issue.
                if (!finished) done(err)
              })
            }
          })
        })

        t.agent.addRemoteConfig(t.rcConfig)
      })
    })
  })

  describe('DD_TRACING_ENABLED=true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED=true', function () {
    const t = setup({
      env: { DD_TRACING_ENABLED: true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: true },
      dependencies: ['fastify']
    })

    describe('input messages', function () {
      it(
        'should capture and send expected payload when a log line probe is triggered',
        testBasicInputWithDD.bind(null, t)
      )
    })
  })

  describe('DD_TRACING_ENABLED=true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED=false', function () {
    const t = setup({
      env: { DD_TRACING_ENABLED: true, DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: false },
      dependencies: ['fastify']
    })

    describe('input messages', function () {
      it(
        'should capture and send expected payload when a log line probe is triggered',
        testBasicInputWithDD.bind(null, t)
      )
    })
  })

  describe('DD_TRACING_ENABLED=false', function () {
    const t = setup({
      env: { DD_TRACING_ENABLED: false },
      dependencies: ['fastify']
    })

    describe('input messages', function () {
      it(
        'should capture and send expected payload when a log line probe is triggered',
        testBasicInputWithoutDD.bind(null, t)
      )
    })
  })
})

function testBasicInputWithDD (t, done) {
  let traceId, spanId, dd

  t.triggerBreakpoint()

  t.agent.on('message', ({ payload }) => {
    const span = payload.find((arr) => arr[0].name === 'fastify.request')?.[0]
    if (!span) return

    traceId = span.trace_id.toString()
    spanId = span.span_id.toString()

    assertDD()
  })

  t.agent.on('debugger-input', ({ payload }) => {
    assertBasicInputPayload(t, payload)

    payload = payload[0]
    assert.isObject(payload.dd)
    assert.hasAllKeys(payload.dd, ['trace_id', 'span_id'])
    assert.typeOf(payload.dd.trace_id, 'string')
    assert.typeOf(payload.dd.span_id, 'string')
    assert.isAbove(payload.dd.trace_id.length, 0)
    assert.isAbove(payload.dd.span_id.length, 0)
    dd = payload.dd

    assertDD()
  })

  t.agent.addRemoteConfig(t.rcConfig)

  function assertDD () {
    if (!traceId || !spanId || !dd) return
    assert.strictEqual(dd.trace_id, traceId)
    assert.strictEqual(dd.span_id, spanId)
    done()
  }
}

function testBasicInputWithoutDD (t, done) {
  t.triggerBreakpoint()

  t.agent.on('debugger-input', ({ payload }) => {
    assertBasicInputPayload(t, payload)
    assert.doesNotHaveAnyKeys(payload[0], ['dd'])
    done()
  })

  t.agent.addRemoteConfig(t.rcConfig)
}

function assertBasicInputPayload (t, payload) {
  assert.isArray(payload)
  assert.lengthOf(payload, 1)
  payload = payload[0]

  const expected = {
    ddsource: 'dd_debugger',
    hostname: os.hostname(),
    service: 'node',
    message: 'Hello World!',
    logger: {
      name: t.breakpoint.deployedFile,
      method: 'fooHandler',
      version,
      thread_name: 'MainThread'
    },
    debugger: {
      snapshot: {
        probe: {
          id: t.rcConfig.config.id,
          version: 0,
          location: { file: t.breakpoint.deployedFile, lines: [String(t.breakpoint.line)] }
        },
        language: 'javascript'
      }
    }
  }

  assertObjectContains(payload, expected)

  assert.match(payload.logger.thread_id, /^pid:\d+$/)

  assertUUID(payload.debugger.snapshot.id)
  assert.isNumber(payload.debugger.snapshot.timestamp)
  assert.isTrue(payload.debugger.snapshot.timestamp > Date.now() - 1000 * 60)
  assert.isTrue(payload.debugger.snapshot.timestamp <= Date.now())

  assert.isArray(payload.debugger.snapshot.stack)
  assert.isAbove(payload.debugger.snapshot.stack.length, 0)
  for (const frame of payload.debugger.snapshot.stack) {
    assert.isObject(frame)
    assert.hasAllKeys(frame, ['fileName', 'function', 'lineNumber', 'columnNumber'])
    assert.isString(frame.fileName)
    assert.isString(frame.function)
    assert.isAbove(frame.lineNumber, 0)
    assert.isAbove(frame.columnNumber, 0)
  }
  const topFrame = payload.debugger.snapshot.stack[0]
  // path seems to be prefeixed with `/private` on Mac
  assert.match(topFrame.fileName, new RegExp(`${t.appFile}$`))
  assert.strictEqual(topFrame.function, 'fooHandler')
  assert.strictEqual(topFrame.lineNumber, t.breakpoint.line)
  assert.strictEqual(topFrame.columnNumber, 3)
}

'use strict'

const os = require('os')

const { assert } = require('chai')
const { pollInterval, setup } = require('./utils')
const { assertObjectContains, assertUUID, failOnException } = require('../helpers')
const { ACKNOWLEDGED, ERROR } = require('../../packages/dd-trace/src/appsec/remote_config/apply_states')
const { version } = require('../../package.json')

describe('Dynamic Instrumentation', function () {
  const t = setup()

  it('base case: target app should work as expected if no test probe has been added', async function () {
    const response = await t.axios.get('/foo')
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(response.data, { hello: 'foo' })
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

      t.agent.on('remote-config-ack-update', failOnException(done, (id, version, state, error) => {
        assert.strictEqual(id, t.rcConfig.id)
        assert.strictEqual(version, 1)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

        receivedAckUpdate = true
        endIfDone()
      }))

      t.agent.on('debugger-diagnostics', failOnException(done, ({ payload }) => {
        const expected = expectedPayloads.shift()
        assertObjectContains(payload, expected)
        assertUUID(payload.debugger.diagnostics.runtimeId)

        if (payload.debugger.diagnostics.status === 'INSTALLED') {
          t.axios.get('/foo')
            .then((response) => {
              assert.strictEqual(response.status, 200)
              assert.deepStrictEqual(response.data, { hello: 'foo' })
            })
            .catch(done)
        } else {
          endIfDone()
        }
      }))

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

      t.agent.on('remote-config-ack-update', failOnException(done, (id, version, state, error) => {
        assert.strictEqual(id, t.rcConfig.id)
        assert.strictEqual(version, ++receivedAckUpdates)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

        endIfDone()
      }))

      t.agent.on('debugger-diagnostics', failOnException(done, ({ payload }) => {
        const expected = expectedPayloads.shift()
        assertObjectContains(payload, expected)
        assertUUID(payload.debugger.diagnostics.runtimeId)
        if (payload.debugger.diagnostics.status === 'INSTALLED') triggers.shift()()
        endIfDone()
      }))

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

      t.agent.on('remote-config-ack-update', failOnException(done, (id, version, state, error) => {
        assert.strictEqual(id, t.rcConfig.id)
        assert.strictEqual(version, 1)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

        receivedAckUpdate = true
        endIfDone()
      }))

      t.agent.on('debugger-diagnostics', failOnException(done, ({ payload }) => {
        const expected = expectedPayloads.shift()
        assertObjectContains(payload, expected)
        assertUUID(payload.debugger.diagnostics.runtimeId)

        if (payload.debugger.diagnostics.status === 'INSTALLED') {
          t.agent.removeRemoteConfig(t.rcConfig.id)
          // Wait a little to see if we get any follow-up `debugger-diagnostics` messages
          setTimeout(() => {
            payloadsProcessed = true
            endIfDone()
          }, pollInterval * 2 * 1000) // wait twice as long as the RC poll interval
        }
      }))

      t.agent.addRemoteConfig(t.rcConfig)

      function endIfDone () {
        if (receivedAckUpdate && payloadsProcessed) done()
      }
    })

    const unsupporedOrInvalidProbes = [[
      'should send expected error diagnostics messages if probe doesn\'t conform to expected schema',
      'bad config!!!',
      { status: 'ERROR' }
    ], [
      'should send expected error diagnostics messages if probe type isn\'t supported',
      t.generateProbeConfig({ type: 'INVALID_PROBE' })
    ], [
      'should send expected error diagnostics messages if it isn\'t a line-probe',
      t.generateProbeConfig({ where: { foo: 'bar' } }) // TODO: Use valid schema for method probe instead
    ]]

    for (const [title, config, customErrorDiagnosticsObj] of unsupporedOrInvalidProbes) {
      it(title, function (done) {
        let receivedAckUpdate = false

        t.agent.on('remote-config-ack-update', failOnException(done, (id, version, state, error) => {
          assert.strictEqual(id, `logProbe_${config.id}`)
          assert.strictEqual(version, 1)
          assert.strictEqual(state, ERROR)
          assert.strictEqual(error.slice(0, 6), 'Error:')

          receivedAckUpdate = true
          endIfDone()
        }))

        const probeId = config.id
        const expectedPayloads = [{
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: { status: 'RECEIVED' } }
        }, {
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: customErrorDiagnosticsObj ?? { probeId, version: 0, status: 'ERROR' } }
        }]

        t.agent.on('debugger-diagnostics', failOnException(done, ({ payload }) => {
          const expected = expectedPayloads.shift()
          assertObjectContains(payload, expected)
          const { diagnostics } = payload.debugger
          assertUUID(diagnostics.runtimeId)

          if (diagnostics.status === 'ERROR') {
            assert.property(diagnostics, 'exception')
            assert.hasAllKeys(diagnostics.exception, ['message', 'stacktrace'])
            assert.typeOf(diagnostics.exception.message, 'string')
            assert.typeOf(diagnostics.exception.stacktrace, 'string')
          }

          endIfDone()
        }))

        t.agent.addRemoteConfig({
          product: 'LIVE_DEBUGGING',
          id: `logProbe_${config.id}`,
          config
        })

        function endIfDone () {
          if (receivedAckUpdate && expectedPayloads.length === 0) done()
        }
      })
    }
  })

  describe('input messages', function () {
    it('should capture and send expected payload when a log line probe is triggered', function (done) {
      t.triggerBreakpoint()

      t.agent.on('debugger-input', failOnException(done, ({ payload }) => {
        const expected = {
          ddsource: 'dd_debugger',
          hostname: os.hostname(),
          service: 'node',
          message: 'Hello World!',
          logger: {
            name: t.breakpoint.file,
            method: 'handler',
            version,
            thread_name: 'MainThread'
          },
          'debugger.snapshot': {
            probe: {
              id: t.rcConfig.config.id,
              version: 0,
              location: { file: t.breakpoint.file, lines: [String(t.breakpoint.line)] }
            },
            language: 'javascript'
          }
        }

        assertObjectContains(payload, expected)
        assert.match(payload.logger.thread_id, /^pid:\d+$/)
        assertUUID(payload['debugger.snapshot'].id)
        assert.isNumber(payload['debugger.snapshot'].timestamp)
        assert.isTrue(payload['debugger.snapshot'].timestamp > Date.now() - 1000 * 60)
        assert.isTrue(payload['debugger.snapshot'].timestamp <= Date.now())

        assert.isArray(payload['debugger.snapshot'].stack)
        assert.isAbove(payload['debugger.snapshot'].stack.length, 0)
        for (const frame of payload['debugger.snapshot'].stack) {
          assert.isObject(frame)
          assert.hasAllKeys(frame, ['fileName', 'function', 'lineNumber', 'columnNumber'])
          assert.isString(frame.fileName)
          assert.isString(frame.function)
          assert.isAbove(frame.lineNumber, 0)
          assert.isAbove(frame.columnNumber, 0)
        }
        const topFrame = payload['debugger.snapshot'].stack[0]
        // path seems to be prefeixed with `/private` on Mac
        assert.match(topFrame.fileName, new RegExp(`${t.appFile}$`))
        assert.strictEqual(topFrame.function, 'handler')
        assert.strictEqual(topFrame.lineNumber, t.breakpoint.line)
        assert.strictEqual(topFrame.columnNumber, 3)

        done()
      }))

      t.agent.addRemoteConfig(t.rcConfig)
    })

    it('should respond with updated message if probe message is updated', function (done) {
      const expectedMessages = ['Hello World!', 'Hello Updated World!']
      const triggers = [
        async () => {
          await t.axios.get('/foo')
          t.rcConfig.config.version++
          t.rcConfig.config.template = 'Hello Updated World!'
          t.agent.updateRemoteConfig(t.rcConfig.id, t.rcConfig.config)
        },
        async () => {
          await t.axios.get('/foo')
        }
      ]

      t.agent.on('debugger-diagnostics', ({ payload }) => {
        if (payload.debugger.diagnostics.status === 'INSTALLED') triggers.shift()().catch(done)
      })

      t.agent.on('debugger-input', failOnException(done, ({ payload }) => {
        assert.strictEqual(payload.message, expectedMessages.shift())
        if (expectedMessages.length === 0) done()
      }))

      t.agent.addRemoteConfig(t.rcConfig)
    })

    it('should not trigger if probe is deleted', function (done) {
      t.agent.on('debugger-diagnostics', failOnException(done, ({ payload }) => {
        if (payload.debugger.diagnostics.status === 'INSTALLED') {
          t.agent.once('remote-confg-responded', failOnException(done, async () => {
            await t.axios.get('/foo')
            // We want to wait enough time to see if the client triggers on the breakpoint so that the test can fail
            // if it does, but not so long that the test times out.
            // TODO: Is there some signal we can use instead of a timer?
            setTimeout(done, pollInterval * 2 * 1000) // wait twice as long as the RC poll interval
          }))

          t.agent.removeRemoteConfig(t.rcConfig.id)
        }
      }))

      t.agent.on('debugger-input', () => {
        done(new Error('should not capture anything when the probe is deleted'))
      })

      t.agent.addRemoteConfig(t.rcConfig)
    })
  })

  describe('race conditions', function () {
    it('should remove the last breakpoint completely before trying to add a new one', function (done) {
      const rcConfig2 = t.generateRemoteConfig()

      t.agent.on('debugger-diagnostics', failOnException(done, ({ payload: { debugger: { diagnostics: { status, probeId } } } }) => {
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
          }, 1000)

          // If we successfully handled the race condition, the probe will trigger, we'll get a probe result and the
          // following event listener will be called:
          t.agent.once('debugger-input', () => {
            clearTimeout(timer)
            finished = true
            done()
          })

          // Perform HTTP request to try and trigger the probe
          t.axios.get('/foo').catch((err) => {
            // If the request hasn't fully completed by the time the tests ends and the target app is destroyed, Axios
            // will complain with a "socket hang up" error. Hence this sanity check before calling `done(err)`. If we
            // later add more tests below this one, this shouuldn't be an issue.
            if (!finished) done(err)
          })
        }
      }))

      t.agent.addRemoteConfig(t.rcConfig)
    })
  })
})

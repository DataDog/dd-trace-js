'use strict'

const path = require('path')
const { randomUUID } = require('crypto')
const getPort = require('get-port')
const Axios = require('axios')
const { assert } = require('chai')
const { assertObjectContains, assertUUID, createSandbox, FakeAgent, spawnProc } = require('../helpers')
const { ACKNOWLEDGED, ERROR } = require('../../packages/dd-trace/src/appsec/remote_config/apply_states')
const { version } = require('../../package.json')

const probeFile = 'debugger/target-app/index.js'
const probeLineNo = 9
const pollInterval = 1

describe('Dynamic Instrumentation', function () {
  let axios, sandbox, cwd, appPort, appFile, agent, proc, probeConfig

  before(async function () {
    sandbox = await createSandbox(['fastify'])
    cwd = sandbox.folder
    appFile = path.join(cwd, ...probeFile.split('/'))
  })

  after(async function () {
    await sandbox.remove()
  })

  beforeEach(async function () {
    const probeId = randomUUID()
    probeConfig = {
      product: 'LIVE_DEBUGGING',
      id: `logProbe_${probeId}`,
      config: generateProbeConfig({ id: probeId })
    }
    appPort = await getPort()
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        APP_PORT: appPort,
        DD_TRACE_AGENT_PORT: agent.port,
        DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: pollInterval,
        DD_DYNAMIC_INSTRUMENTATION_ENABLED: true
      }
    })
    axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  afterEach(async function () {
    proc.kill()
    await agent.stop()
  })

  it('base case: target app should work as expected if no test probe has been added', async function () {
    const response = await axios.get('/foo')
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(response.data, { hello: 'foo' })
  })

  describe('diagnostics messages', function () {
    it('should send expected diagnostics messages if probe is received and triggered', function (done) {
      let receivedAckUpdate = false
      const probeId = probeConfig.config.id
      const expectedPayloads = [{
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 0, status: 'RECEIVED' } }
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 0, status: 'INSTALLED' } }
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 0, status: 'EMITTING' } }
      }]

      agent.on('remote-config-ack-update', (id, version, state, error) => {
        assert.strictEqual(id, probeConfig.id)
        assert.strictEqual(version, 1)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

        receivedAckUpdate = true
        endIfDone()
      })

      agent.on('debugger-diagnostics', async ({ payload }) => {
        try {
          const expected = expectedPayloads.shift()
          assertObjectContains(payload, expected)
          assertUUID(payload.debugger.diagnostics.runtimeId)

          if (payload.debugger.diagnostics.status === 'INSTALLED') {
            const response = await axios.get('/foo')
            assert.strictEqual(response.status, 200)
            assert.deepStrictEqual(response.data, { hello: 'foo' })
          }

          endIfDone()
        } catch (err) {
          // Nessecary hack: Any errors thrown inside of an async function is invisible to Mocha unless the outer `it`
          // callback is also `async` (which we can't do in this case since we rely on the `done` callback).
          done(err)
        }
      })

      agent.addRemoteConfig(probeConfig)

      function endIfDone () {
        if (receivedAckUpdate && expectedPayloads.length === 0) done()
      }
    })

    it('should send expected diagnostics messages if probe is first received and then updated', function (done) {
      let receivedAckUpdates = 0
      const probeId = probeConfig.config.id
      const expectedPayloads = [{
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 0, status: 'RECEIVED' } }
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 0, status: 'INSTALLED' } }
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 1, status: 'RECEIVED' } }
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 1, status: 'INSTALLED' } }
      }]
      const triggers = [
        () => {
          probeConfig.config.version++
          agent.updateRemoteConfig(probeConfig.id, probeConfig.config)
        },
        () => {}
      ]

      agent.on('remote-config-ack-update', (id, version, state, error) => {
        assert.strictEqual(id, probeConfig.id)
        assert.strictEqual(version, ++receivedAckUpdates)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

        endIfDone()
      })

      agent.on('debugger-diagnostics', ({ payload }) => {
        const expected = expectedPayloads.shift()
        assertObjectContains(payload, expected)
        assertUUID(payload.debugger.diagnostics.runtimeId)
        if (payload.debugger.diagnostics.status === 'INSTALLED') triggers.shift()()
        endIfDone()
      })

      agent.addRemoteConfig(probeConfig)

      function endIfDone () {
        if (receivedAckUpdates === 2 && expectedPayloads.length === 0) done()
      }
    })

    it('should send expected diagnostics messages if probe is first received and then deleted', function (done) {
      let receivedAckUpdate = false
      let payloadsProcessed = false
      const probeId = probeConfig.config.id
      const expectedPayloads = [{
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 0, status: 'RECEIVED' } }
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, version: 0, status: 'INSTALLED' } }
      }]

      agent.on('remote-config-ack-update', (id, version, state, error) => {
        assert.strictEqual(id, probeConfig.id)
        assert.strictEqual(version, 1)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

        receivedAckUpdate = true
        endIfDone()
      })

      agent.on('debugger-diagnostics', ({ payload }) => {
        const expected = expectedPayloads.shift()
        assertObjectContains(payload, expected)
        assertUUID(payload.debugger.diagnostics.runtimeId)

        if (payload.debugger.diagnostics.status === 'INSTALLED') {
          agent.removeRemoteConfig(probeConfig.id)
          // Wait a little to see if we get any follow-up `debugger-diagnostics` messages
          setTimeout(() => {
            payloadsProcessed = true
            endIfDone()
          }, pollInterval * 2 * 1000) // wait twice as long as the RC poll interval
        }
      })

      agent.addRemoteConfig(probeConfig)

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
      generateProbeConfig({ type: 'INVALID_PROBE' })
    ], [
      'should send expected error diagnostics messages if it isn\'t a line-probe',
      generateProbeConfig({ where: { foo: 'bar' } }) // TODO: Use valid schema for method probe instead
    ]]

    for (const [title, config, customErrorDiagnosticsObj] of unsupporedOrInvalidProbes) {
      it(title, function (done) {
        let receivedAckUpdate = false

        agent.on('remote-config-ack-update', (id, version, state, error) => {
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
          debugger: { diagnostics: customErrorDiagnosticsObj ?? { probeId, version: 0, status: 'ERROR' } }
        }]

        agent.on('debugger-diagnostics', ({ payload }) => {
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
        })

        agent.addRemoteConfig({
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
    it('should capture and send expected snapshot when a log line probe is triggered', function (done) {
      agent.on('debugger-diagnostics', ({ payload }) => {
        if (payload.debugger.diagnostics.status === 'INSTALLED') {
          axios.get('/foo')
        }
      })

      agent.on('debugger-input', ({ payload }) => {
        const expected = {
          ddsource: 'dd_debugger',
          service: 'node',
          message: 'Hello World!',
          logger: {
            name: 'debugger/target-app/index.js',
            method: 'handler',
            version,
            thread_name: 'MainThread'
          },
          'debugger.snapshot': {
            probe: {
              id: probeConfig.config.id,
              version: 0,
              location: { file: probeFile, lines: [probeLineNo] }
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

        done()
      })

      agent.addRemoteConfig(probeConfig)
    })

    it('should respond with updated message if probe message is updated', function (done) {
      const expectedMessages = ['Hello World!', 'Hello Updated World!']
      const triggers = [
        async () => {
          await axios.get('/foo')
          probeConfig.config.version++
          probeConfig.config.template = 'Hello Updated World!'
          agent.updateRemoteConfig(probeConfig.id, probeConfig.config)
        },
        async () => {
          await axios.get('/foo')
        }
      ]

      agent.on('debugger-diagnostics', ({ payload }) => {
        if (payload.debugger.diagnostics.status === 'INSTALLED') triggers.shift()().catch(done)
      })

      agent.on('debugger-input', ({ payload }) => {
        assert.strictEqual(payload.message, expectedMessages.shift())
        if (expectedMessages.length === 0) done()
      })

      agent.addRemoteConfig(probeConfig)
    })

    it('should not trigger if probe is deleted', function (done) {
      agent.on('debugger-diagnostics', async ({ payload }) => {
        try {
          if (payload.debugger.diagnostics.status === 'INSTALLED') {
            agent.once('remote-confg-responded', async () => {
              try {
                await axios.get('/foo')
                // We want to wait enough time to see if the client triggers on the breakpoint so that the test can fail
                // if it does, but not so long that the test times out.
                // TODO: Is there some signal we can use instead of a timer?
                setTimeout(done, pollInterval * 2 * 1000) // wait twice as long as the RC poll interval
              } catch (err) {
                // Nessecary hack: Any errors thrown inside of an async function is invisible to Mocha unless the outer
                // `it` callback is also `async` (which we can't do in this case since we rely on the `done` callback).
                done(err)
              }
            })

            agent.removeRemoteConfig(probeConfig.id)
          }
        } catch (err) {
          // Nessecary hack: Any errors thrown inside of an async function is invisible to Mocha unless the outer `it`
          // callback is also `async` (which we can't do in this case since we rely on the `done` callback).
          done(err)
        }
      })

      agent.on('debugger-input', () => {
        assert.fail('should not capture anything when the probe is deleted')
      })

      agent.addRemoteConfig(probeConfig)
    })
  })

  describe('race conditions', () => {
    it('should remove the last breakpoint completely before trying to add a new one', (done) => {
      const probeId1 = probeConfig.config.id
      const probeId2 = randomUUID()
      const probeConfig2 = {
        product: 'LIVE_DEBUGGING',
        id: `logProbe_${probeId2}`,
        config: generateProbeConfig({ id: probeId2 })
      }

      agent.on('debugger-diagnostics', ({ payload: { debugger: { diagnostics: { status, probeId } } } }) => {
        if (status !== 'INSTALLED') return

        if (probeId === probeId1) {
          // First INSTALLED payload: Try to trigger the race condition.
          agent.removeRemoteConfig(probeConfig.id)
          agent.addRemoteConfig(probeConfig2)
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
          agent.once('debugger-input', () => {
            clearTimeout(timer)
            finished = true
            done()
          })

          // Perform HTTP request to try and trigger the probe
          axios.get('/foo').catch((err) => {
            // If the request hasn't fully completed by the time the tests ends and the target app is destroyed, Axios
            // will complain with a "socket hang up" error. Hence this sanity check before calling `done(err)`. If we
            // later add more tests below this one, this shouuldn't be an issue.
            if (!finished) done(err)
          })
        }
      })

      agent.addRemoteConfig(probeConfig)
    })
  })
})

function generateProbeConfig (overrides) {
  return {
    id: randomUUID(),
    version: 0,
    type: 'LOG_PROBE',
    language: 'javascript',
    where: { sourceFile: probeFile, lines: [String(probeLineNo)] },
    tags: [],
    template: 'Hello World!',
    segments: [{ str: 'Hello World!' }],
    captureSnapshot: false,
    capture: { maxReferenceDepth: 3 },
    sampling: { snapshotsPerSecond: 5000 },
    evaluateAt: 'EXIT',
    ...overrides
  }
}

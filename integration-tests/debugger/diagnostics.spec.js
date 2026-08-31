'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { assertObjectContains, assertUUID, stopProc } = require('../helpers')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('../../packages/dd-trace/src/remote_config/apply_states')
const { pollInterval, setup } = require('./utils')

/**
 * @param {import('node:events').EventEmitter} agent
 * @param {string} configId
 * @param {Array<object>} expectedPayloads
 * @param {number} expectedAckUpdates
 * @param {() => void} [onInstalled]
 */
function expectProbeEvents (agent, configId, expectedPayloads, expectedAckUpdates, onInstalled) {
  return new Promise((resolve, reject) => {
    let ackUpdates = 0
    let quietPeriod

    /** @param {Error} [error] */
    function finish (error) {
      clearTimeout(quietPeriod)
      agent.removeListener('debugger-diagnostics', handleDiagnostics)
      agent.removeListener('remote-config-ack-update', handleAckUpdate)
      if (error) reject(error)
      else resolve()
    }

    function observeQuietPeriod () {
      if (expectedPayloads.length !== 0) return
      clearTimeout(quietPeriod)
      quietPeriod = setTimeout(() => {
        try {
          assert.strictEqual(ackUpdates, expectedAckUpdates)
          finish()
        } catch (error) {
          finish(error)
        }
      }, pollInterval * 2 * 1000)
    }

    /**
     * @param {string} id
     * @param {number} version
     * @param {number} state
     * @param {string} error
     */
    function handleAckUpdate (id, version, state, error) {
      if (state === UNACKNOWLEDGED) return

      try {
        assert.strictEqual(id, configId)
        assert.strictEqual(version, ++ackUpdates)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.ok(!error)
        observeQuietPeriod()
      } catch (error) {
        finish(error)
      }
    }

    /** @param {{ payload: Array<object> }} event */
    function handleDiagnostics ({ payload }) {
      try {
        for (const event of payload) {
          const expected = expectedPayloads.shift()
          assert.ok(expected, 'Received an unexpected diagnostics payload')
          assertObjectContains(event, expected)
          assertUUID(event.debugger.diagnostics.runtimeId)
          if (event.debugger.diagnostics.status === 'INSTALLED') onInstalled?.()
        }
        observeQuietPeriod()
      } catch (error) {
        finish(error)
      }
    }

    agent.on('debugger-diagnostics', handleDiagnostics)
    agent.on('remote-config-ack-update', handleAckUpdate)
  })
}

/**
 * @param {ReturnType<typeof setup>} t
 * @param {Array<{ id: string, config: { id: string } }>} configs
 * @param {number} expectedCount
 */
async function captureEmittingProbesUntilExit (t, configs, expectedCount) {
  const configuredProbeIds = configs.map(config => config.config.id)
  const probesInstalled = t.waitForProbeStatus(configuredProbeIds, 'INSTALLED')

  for (const config of configs) {
    t.agent.addRemoteConfig(config)
  }
  await probesInstalled

  const emittingProbeIds = []
  let resolveExpected
  const expectedProbesReceived = expectedCount === 0
    ? Promise.resolve()
    : new Promise(resolve => { resolveExpected = resolve })

  /** @param {{ payload: Array<{ debugger: { diagnostics: { probeId: string, status: string } } }> }} event */
  function handleDiagnostics ({ payload }) {
    for (const event of payload) {
      const { diagnostics } = event.debugger
      if (diagnostics.status !== 'EMITTING') continue

      emittingProbeIds.push(diagnostics.probeId)
      if (emittingProbeIds.length === expectedCount) resolveExpected()
    }
  }

  t.agent.on('debugger-diagnostics', handleDiagnostics)
  try {
    const [response] = await Promise.all([
      t.axios.get(t.breakpoint.url),
      expectedProbesReceived,
    ])
    await stopProc(t.proc)
    return { configuredProbeIds, emittingProbeIds, response }
  } finally {
    t.agent.removeListener('debugger-diagnostics', handleDiagnostics)
  }
}

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  before(function () {
    require('../../packages/dd-trace/src/process-tags').initialize()
  })

  describe('diagnostics messages', function () {
    it('should send expected diagnostics messages if probe is received and triggered', async function () {
      const probeId = t.rcConfig.config.id
      const expectedPayloads = [{
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 0, status: 'RECEIVED' } },
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 0, status: 'INSTALLED' } },
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 0, status: 'EMITTING' } },
      }]

      const breakpointTriggered = t.triggerBreakpoint()
      const probeEvents = expectProbeEvents(t.agent, t.rcConfig.id, expectedPayloads, 1)
      t.agent.addRemoteConfig(t.rcConfig)
      const [response] = await Promise.all([breakpointTriggered, probeEvents])
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(response.body, { hello: 'bar' })
    })

    it('should send expected diagnostics messages if probe is first received and then updated', async function () {
      const probeId = t.rcConfig.config.id
      const expectedPayloads = [{
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 0, status: 'RECEIVED' } },
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 0, status: 'INSTALLED' } },
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 1, status: 'RECEIVED' } },
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 1, status: 'INSTALLED' } },
      }]
      const triggers = [
        () => {
          t.rcConfig.config.version++
          t.agent.updateRemoteConfig(t.rcConfig.id, t.rcConfig.config)
        },
        () => {},
      ]

      const probeEvents = expectProbeEvents(t.agent, t.rcConfig.id, expectedPayloads, 2, () => {
        const trigger = triggers.shift()
        assert.ok(trigger, 'expecting a trigger function to be defined')
        trigger()
      })

      t.agent.addRemoteConfig(t.rcConfig)
      await probeEvents
    })

    it('should send expected diagnostics messages if probe is first received and then deleted', async function () {
      const probeId = t.rcConfig.config.id
      const expectedPayloads = [{
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 0, status: 'RECEIVED' } },
      }, {
        ddsource: 'dd_debugger',
        service: 'node',
        debugger: { diagnostics: { probeId, probeVersion: 0, status: 'INSTALLED' } },
      }]

      const probeEvents = expectProbeEvents(t.agent, t.rcConfig.id, expectedPayloads, 1, () => {
        t.agent.removeRemoteConfig(t.rcConfig.id)
      })

      t.agent.addRemoteConfig(t.rcConfig)
      await probeEvents
    })

    it(
      'should send expected error diagnostics messages if probe doesn\'t conform to expected schema',
      unsupportedOrInvalidProbesTest({ invalid: 'config' }, { status: 'ERROR' })
    )

    it(
      'should send expected error diagnostics messages if probe type isn\'t supported',
      // @ts-expect-error Expecting this probe type to be invalid
      unsupportedOrInvalidProbesTest(t.generateProbeConfig({ type: 'INVALID_PROBE' }))
    )

    it(
      'should send expected error diagnostics messages if it isn\'t a line-probe',
      unsupportedOrInvalidProbesTest(
        // @ts-expect-error Expecting this probe type to be invalid
        t.generateProbeConfig({ where: { typeName: 'index.js', methodName: 'handlerA' } })
      )
    )

    function unsupportedOrInvalidProbesTest (config, customErrorDiagnosticsObj) {
      return function (done) {
        let receivedAckUpdate = false

        t.agent.on('remote-config-ack-update', (id, version, state, error) => {
          // Transitional UNACKNOWLEDGED can arrive before the worker transitions to ERROR.
          if (state === UNACKNOWLEDGED) return

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
          debugger: { diagnostics: { status: 'RECEIVED' } },
        }, {
          ddsource: 'dd_debugger',
          service: 'node',
          debugger: { diagnostics: customErrorDiagnosticsObj ?? { probeId, probeVersion: 0, status: 'ERROR' } },
        }]

        t.agent.on('debugger-diagnostics', ({ payload }) => {
          payload.forEach((event) => {
            const expected = expectedPayloads.shift()
            assertObjectContains(event, expected)
            const { diagnostics } = event.debugger
            assertUUID(diagnostics.runtimeId)

            if (diagnostics.status === 'ERROR') {
              assert.ok(Object.hasOwn(diagnostics, 'exception'), `Available keys: ${inspect(Object.keys(diagnostics))}`)
              assert.deepStrictEqual(['message', 'stacktrace'], Object.keys(diagnostics.exception).sort())
              assert.strictEqual(typeof diagnostics.exception.message, 'string')
              assert.strictEqual(typeof diagnostics.exception.stacktrace, 'string')
            }

            endIfDone()
          })
        })

        t.agent.addRemoteConfig({
          product: 'LIVE_DEBUGGING',
          id: `logProbe_${config.id}`,
          config,
        })

        function endIfDone () {
          if (receivedAckUpdate && expectedPayloads.length === 0) done()
        }
      }
    }

    describe('multiple probes at the same location', function () {
      it('should support adding multiple probes at the same location', async function () {
        const configs = [t.generateRemoteConfig(), t.generateRemoteConfig()]
        const probeIds = configs.map(config => config.config.id)
        const probesInstalled = t.waitForProbeStatus(probeIds, 'INSTALLED')

        for (const config of configs) {
          t.agent.addRemoteConfig(config)
        }

        const diagnosticsByProbeId = await probesInstalled
        assert.deepStrictEqual([...diagnosticsByProbeId.keys()].sort(), probeIds.sort())
      })

      it('should support triggering multiple probes added at the same location', async function () {
        const configs = [t.generateRemoteConfig(), t.generateRemoteConfig()]
        const { configuredProbeIds, emittingProbeIds, response } =
          await captureEmittingProbesUntilExit(t, configs, 2)

        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(emittingProbeIds.sort(), configuredProbeIds.sort())
      })

      it('should support not triggering any probes when all conditions are not met', async function () {
        const configs = [
          t.generateRemoteConfig({ when: { json: { eq: [{ ref: 'foo' }, 'bar'] } } }),
          t.generateRemoteConfig({ when: { json: { eq: [{ ref: 'foo' }, 'baz'] } } }),
        ]
        const { emittingProbeIds, response } = await captureEmittingProbesUntilExit(t, configs, 0)

        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(emittingProbeIds, [])
      })

      it('should only trigger the probes whose conditions are met (all have conditions)', async function () {
        const configs = [
          t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } },
          }),
          t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } },
          }),
        ]
        const { emittingProbeIds, response } = await captureEmittingProbesUntilExit(t, configs, 1)

        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(emittingProbeIds, [configs[1].config.id])
      })

      it('triggers on a met condition even if another condition throws', async function () {
        const configs = [
          t.generateRemoteConfig({ when: { json: { eq: [{ ref: 'foo' }, 'bar'] } } }),
          t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } },
          }),
        ]
        const { emittingProbeIds, response } = await captureEmittingProbesUntilExit(t, configs, 1)

        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(emittingProbeIds, [configs[1].config.id])
      })

      it('should only trigger the probes whose conditions are met (not all have conditions)', async function () {
        const configs = [
          t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } },
          }),
          t.generateRemoteConfig({
            when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } },
          }),
          t.generateRemoteConfig(),
        ]
        const { emittingProbeIds, response } = await captureEmittingProbesUntilExit(t, configs, 2)

        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(emittingProbeIds.sort(), [configs[1].config.id, configs[2].config.id].sort())
      })
    })
  })
})

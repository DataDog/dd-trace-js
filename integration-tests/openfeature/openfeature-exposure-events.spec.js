'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { inspect } = require('node:util')

const { assertObjectContains, sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc } = require('../helpers')
const { UNACKNOWLEDGED, ACKNOWLEDGED } = require('../../packages/dd-trace/src/remote_config/apply_states')
const ufcPayloads = require('./fixtures/ufc-payloads')

const RC_PRODUCT = 'FFE_FLAGS'

// Observe beyond the writer's one-second interval so a duplicate periodic flush remains visible.
const EXPOSURE_QUIET_PERIOD_MS = 1250

/**
 * @param {FakeAgent} agent
 * @param {{ id: string, product: string, config: object }} config
 */
function addRemoteConfigAndWaitForAcknowledgment (agent, config) {
  return new Promise((resolve, reject) => {
    /** @param {Error} [error] */
    function finish (error) {
      agent.removeListener('remote-config-ack-update', handleAcknowledgment)
      if (error) reject(error)
      else resolve()
    }

    /**
     * @param {string} id
     * @param {number} version
     * @param {number} state
     * @param {string} error
     */
    function handleAcknowledgment (id, version, state, error) {
      if (state === UNACKNOWLEDGED || id !== config.id) return

      try {
        assert.strictEqual(version, 1)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.ok(!error)
        finish()
      } catch (error) {
        finish(error)
      }
    }

    agent.on('remote-config-ack-update', handleAcknowledgment)
    try {
      agent.addRemoteConfig(config)
    } catch (error) {
      finish(error)
    }
  })
}

/**
 * @param {FakeAgent} agent
 * @param {import('node:child_process').ChildProcess} proc
 * @param {number} expectedCount
 * @param {() => Promise<void>} action
 * @returns {Promise<{
 *   requests: Array<{ payload: { exposures?: Array<object> }, headers: object, path: string }>,
 *   earliestTimestamp: number,
 *   latestTimestamp: number
 * }>}
 */
async function captureExposureRequestsUntilExit (agent, proc, expectedCount, action) {
  const earliestTimestamp = Date.now()
  const requests = []
  let exposureCount = 0
  let resolveExpected
  const expectedExposuresReceived = new Promise(resolve => { resolveExpected = resolve })

  /** @param {{ payload: { exposures?: Array<object> }, headers: object, path: string }} request */
  function handleExposures (request) {
    requests.push(request)
    const { exposures } = request.payload
    if (!Array.isArray(exposures)) {
      resolveExpected()
      return
    }

    exposureCount += exposures.length
    if (exposureCount >= expectedCount) resolveExpected()
  }

  agent.on('exposures', handleExposures)
  try {
    await Promise.all([action(), expectedExposuresReceived])
    await delay(EXPOSURE_QUIET_PERIOD_MS)
    const latestTimestamp = Date.now()
    await stopProc(proc)
    return { requests, earliestTimestamp, latestTimestamp }
  } finally {
    agent.removeListener('exposures', handleExposures)
  }
}

/**
 * @param {number} timestamp
 * @param {number} earliestTimestamp
 * @param {number} latestTimestamp
 */
function assertTimestampWithin (timestamp, earliestTimestamp, latestTimestamp) {
  assert.strictEqual(typeof timestamp, 'number')
  assert.ok(timestamp >= earliestTimestamp, `Expected timestamp ${timestamp} to be at least ${earliestTimestamp}`)
  assert.ok(timestamp <= latestTimestamp, `Expected timestamp ${timestamp} to be at most ${latestTimestamp}`)
}

/**
 * @param {object} event
 * @param {string} expectedFlag
 * @param {string} expectedUser
 * @param {number} earliestTimestamp
 * @param {number} latestTimestamp
 * @param {object} [expectedAttributes]
 */
function validateExposureEvent (
  event,
  expectedFlag,
  expectedUser,
  earliestTimestamp,
  latestTimestamp,
  expectedAttributes = {}
) {
  assert.ok(Object.hasOwn(event, 'timestamp'), `Available keys: ${inspect(Object.keys(event))}`)
  assert.ok(Object.hasOwn(event, 'flag'), `Available keys: ${inspect(Object.keys(event))}`)
  assert.ok(Object.hasOwn(event, 'variant'), `Available keys: ${inspect(Object.keys(event))}`)
  assert.ok(Object.hasOwn(event, 'subject'), `Available keys: ${inspect(Object.keys(event))}`)

  assert.strictEqual(event.flag.key, expectedFlag)
  assert.strictEqual(event.subject.id, expectedUser)

  if (Object.keys(expectedAttributes).length > 0) {
    assert.deepStrictEqual(event.subject.attributes, expectedAttributes)
  }

  assertTimestampWithin(event.timestamp, earliestTimestamp, latestTimestamp)
}

describe('OpenFeature Remote Config and Exposure Events Integration', () => {
  let cwd, appFile

  // Dependencies needed for OpenFeature integration tests
  const dependencies = [
    'express',
    '@openfeature/server-sdk',
    '@openfeature/core',
  ]

  useSandbox(
    dependencies,
    false,
    [path.join(__dirname, 'app')]
  )

  before(function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'app', 'exposure-events.js')
  })

  describe('FlaggingProvider evaluation generates exposures', () => {
    describe('with manual flush', () => {
      let agent, proc

      beforeEach(async () => {
        agent = await new FakeAgent(0, { evpProxyVersions: [2, 4] }).start()
        proc = await spawnProc(appFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.1',
            DD_FEATURE_FLAGS_ENABLED: 'true',
            // Preserve the existing RC exposure path until agentless emission is supported.
            DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config',
          },
        })
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      it('should generate exposure events with manual flush', async function () {
        const configId = 'org-42-env-test'
        await addRemoteConfigAndWaitForAcknowledgment(agent, {
          product: RC_PRODUCT,
          id: configId,
          config: ufcPayloads.testBooleanAndStringFlags,
        })

        const { requests, earliestTimestamp, latestTimestamp } =
          await captureExposureRequestsUntilExit(agent, proc, 2, async function () {
            const response = await fetch(`${proc.url}/evaluate-flags`)
            assert.strictEqual(response.status, 200)
            const data = await response.json()
            assert.strictEqual(data.evaluationsCompleted, 2)

            const flushResponse = await fetch(`${proc.url}/flush`)
            assert.strictEqual(flushResponse.status, 200)
          })
        const exposureEvents = []

        for (const { payload, headers, path: requestPath } of requests) {
          assert.ok(Object.hasOwn(payload, 'exposures'), `Available keys: ${inspect(Object.keys(payload))}`)
          assertObjectContains(payload, {
            context: {
              service: 'ffe-test-service',
              version: '1.2.3',
              env: 'test',
            },
          })

          exposureEvents.push(...payload.exposures)

          assert.strictEqual(headers['content-type'], 'application/json')
          assert.strictEqual(headers['x-datadog-evp-subdomain'], 'event-platform-intake')
          assert.strictEqual(requestPath, '/evp_proxy/v2/api/v2/exposures')
        }

        assert.strictEqual(exposureEvents.length, 2)

        const booleanEvent = exposureEvents.find(event => event.flag.key === 'test-boolean-flag')
        const stringEvent = exposureEvents.find(event => event.flag.key === 'test-string-flag')

        assert.ok(booleanEvent, 'Should have boolean flag exposure')
        assert.ok(stringEvent, 'Should have string flag exposure')

        validateExposureEvent(booleanEvent, 'test-boolean-flag', 'test-user-123', earliestTimestamp, latestTimestamp,
          { user: 'test-user-123', plan: 'premium' })
        validateExposureEvent(stringEvent, 'test-string-flag', 'test-user-456', earliestTimestamp, latestTimestamp,
          { user: 'test-user-456', tier: 'enterprise' })
      })
    })

    describe('with automatic flush', () => {
      let agent, proc

      beforeEach(async () => {
        agent = await new FakeAgent().start()
        proc = await spawnProc(appFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.1',
            DD_FEATURE_FLAGS_ENABLED: 'true',
            DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config',
          },
        })
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      it('should handle multiple flag evaluations with automatic flush', async function () {
        const configId = 'org-42-env-test'
        await addRemoteConfigAndWaitForAcknowledgment(agent, {
          product: RC_PRODUCT,
          id: configId,
          config: ufcPayloads.testBooleanAndStringFlags,
        })

        const { requests, earliestTimestamp, latestTimestamp } =
          await captureExposureRequestsUntilExit(agent, proc, 6, async function () {
            const response = await fetch(`${proc.url}/evaluate-multiple-flags`)
            assert.strictEqual(response.status, 200)
            const data = await response.json()
            assert.strictEqual(data.evaluationsCompleted, 6)
          })
        const exposureEvents = []

        for (const { payload } of requests) {
          assert.ok(Object.hasOwn(payload, 'exposures'), `Available keys: ${inspect(Object.keys(payload))}`)
          assertObjectContains(payload, {
            context: {
              service: 'ffe-test-service',
              version: '1.2.3',
              env: 'test',
            },
          })

          exposureEvents.push(...payload.exposures)
        }

        assert.strictEqual(exposureEvents.length, 6)

        for (const event of exposureEvents) {
          assertTimestampWithin(event.timestamp, earliestTimestamp, latestTimestamp)
        }

        const booleanEvents = exposureEvents.filter(event => event.flag.key === 'test-boolean-flag')
        const stringEvents = exposureEvents.filter(event => event.flag.key === 'test-string-flag')

        assert.strictEqual(booleanEvents.length, 3)
        assert.strictEqual(stringEvents.length, 3)

        const userIds = new Set(exposureEvents.map(event => event.subject.id))
        assert.deepStrictEqual(userIds, new Set(['user-1', 'user-2', 'user-3']))
      })
    })
  })

  describe('Remote Config acknowledgment', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.1',
          DD_FEATURE_FLAGS_ENABLED: 'true',
          DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config',
        },
      })
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    it('should acknowledge UFC configuration delivery via Remote Config', async function () {
      const configId = 'org-42-env-test'
      const acknowledgment = addRemoteConfigAndWaitForAcknowledgment(agent, {
        product: RC_PRODUCT,
        id: configId,
        config: ufcPayloads.simpleStringFlagForAck,
      })
      const response = fetch(`${proc.url}/`)

      const [, result] = await Promise.all([acknowledgment, response])
      assert.strictEqual(result.status, 200)
    })
  })

  describe('Error handling', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_FEATURE_FLAGS_ENABLED: 'false',
        },
      })
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    it('should handle disabled flagging provider gracefully', async () => {
      const response = await fetch(`${proc.url}/evaluate-flags`)
      assert.strictEqual(response.status, 200)
      const data = await response.json()
      // When provider is disabled, it uses noop provider which returns default values
      assertObjectContains(data, {
        results: {
          boolean: false,
          string: 'default',
        },
        evaluationsCompleted: 2,
      })
    })
  })
})

'use strict'

const assert = require('node:assert/strict')

const path = require('path')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../helpers')
const { UNACKNOWLEDGED, ACKNOWLEDGED } = require('../../packages/dd-trace/src/remote_config/apply_states')
const ufcPayloads = require('./fixtures/ufc-payloads')
const RC_PRODUCT = 'FFE_FLAGS'

// Helper function to check exposure event structure
function validateExposureEvent (event, expectedFlag, expectedUser, expectedAttributes = {}) {
  assert.ok(Object.hasOwn(event, 'timestamp'))
  assert.ok(Object.hasOwn(event, 'flag'))
  assert.ok(Object.hasOwn(event, 'variant'))
  assert.ok(Object.hasOwn(event, 'subject'))

  assert.strictEqual(event.flag.key, expectedFlag)
  assert.strictEqual(event.subject.id, expectedUser)

  if (Object.keys(expectedAttributes).length > 0) {
    assert.deepStrictEqual(event.subject.attributes, expectedAttributes)
  }

  assert.strictEqual(typeof event.timestamp, 'number')
  assert.strictEqual(Date.now() - event.timestamp < 10000, true) // Within last 10 seconds
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
        agent = await new FakeAgent().start()
        proc = await spawnProc(appFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.1',
            DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: 'true'
          }
        })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('should generate exposure events with manual flush', (done) => {
        const configId = 'org-42-env-test'
        const exposureEvents = []
        let receivedAckUpdate = false

        // Listen for exposure events
        agent.on('exposures', ({ payload, headers }) => {
          assert.ok(Object.hasOwn(payload, 'context'))
          assert.ok(Object.hasOwn(payload, 'exposures'))
          assert.strictEqual(payload.context.service, 'ffe-test-service')
          assert.strictEqual(payload.context.version, '1.2.3')
          assert.strictEqual(payload.context.env, 'test')

          exposureEvents.push(...payload.exposures)

          if (exposureEvents.length === 2) {
            try {
              assert.strictEqual(headers['content-type'], 'application/json')
              assert.strictEqual(headers['x-datadog-evp-subdomain'], 'event-platform-intake')

              // Verify we got exposure events from flag evaluations
              assert.strictEqual(exposureEvents.length, 2)

              const booleanEvent = exposureEvents.find(e => e.flag.key === 'test-boolean-flag')
              const stringEvent = exposureEvents.find(e => e.flag.key === 'test-string-flag')

              assert.ok(booleanEvent, 'Should have boolean flag exposure')
              assert.ok(stringEvent, 'Should have string flag exposure')

              // Verify exposure event structure using helper
              validateExposureEvent(booleanEvent, 'test-boolean-flag', 'test-user-123',
                { user: 'test-user-123', plan: 'premium' })
              validateExposureEvent(stringEvent, 'test-string-flag', 'test-user-456',
                { user: 'test-user-456', tier: 'enterprise' })

              endIfDone()
            } catch (error) {
              done(error)
            }
          }
        })

        agent.on('remote-config-ack-update', async (id, _version, state) => {
          if (state === UNACKNOWLEDGED) return

          if (id !== configId) return

          try {
            assert.strictEqual(state, ACKNOWLEDGED)
            receivedAckUpdate = true

            const response = await fetch(`${proc.url}/evaluate-flags`)
            assert.strictEqual(response.status, 200)
            const data = await response.json()
            assert.strictEqual(data.evaluationsCompleted, 2)

            // Trigger manual flush to send exposure events
            await fetch(`${proc.url}/flush`)
          } catch (error) {
            done(error)
          }
        })

        // Deliver UFC config via Remote Config
        agent.addRemoteConfig({
          product: RC_PRODUCT,
          id: configId,
          config: ufcPayloads.testBooleanAndStringFlags
        })

        function endIfDone () {
          if (receivedAckUpdate && exposureEvents.length === 2) done()
        }
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
            DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: 'true'
          }
        })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('should handle multiple flag evaluations with automatic flush', (done) => {
        const configId = 'org-42-env-test'
        const exposureEvents = []

        agent.on('exposures', ({ payload }) => {
          assert.ok(Object.hasOwn(payload, 'context'))
          assert.ok(Object.hasOwn(payload, 'exposures'))
          assert.strictEqual(payload.context.service, 'ffe-test-service')
          assert.strictEqual(payload.context.version, '1.2.3')
          assert.strictEqual(payload.context.env, 'test')

          exposureEvents.push(...payload.exposures)

          if (exposureEvents.length >= 6) {
            try {
              assert.strictEqual(exposureEvents.length, 6)

              const booleanEvents = exposureEvents.filter(e => e.flag.key === 'test-boolean-flag')
              const stringEvents = exposureEvents.filter(e => e.flag.key === 'test-string-flag')

              assert.strictEqual(booleanEvents.length, 3)
              assert.strictEqual(stringEvents.length, 3)

              // Verify different users
              const userIds = new Set(exposureEvents.map(e => e.subject.id))
              assert.deepStrictEqual(userIds, new Set(['user-1', 'user-2', 'user-3']))

              done()
            } catch (error) {
              done(error)
            }
          }
        })

        agent.on('remote-config-ack-update', async (id, _version, state) => {
          if (state === UNACKNOWLEDGED) return
          if (id !== configId) return
          try {
            assert.strictEqual(state, ACKNOWLEDGED)

            const response = await fetch(`${proc.url}/evaluate-multiple-flags`)
            assert.strictEqual(response.status, 200)
            const data = await response.json()
            assert.strictEqual(data.evaluationsCompleted, 6)

            // No manual flush - let automatic flush handle it (default 1s interval)
          } catch (error) {
            done(error)
          }
        })

        agent.addRemoteConfig({
          product: RC_PRODUCT,
          id: configId,
          config: ufcPayloads.testBooleanAndStringFlags
        })
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
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: 'true'
        }
      })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should acknowledge UFC configuration delivery via Remote Config', (done) => {
      const configId = 'org-42-env-test'
      let receivedAckUpdate = false

      agent.on('remote-config-ack-update', (id, version, state, error) => {
        // Due to the very short DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS, there's a race condition in which we might
        // get an UNACKNOWLEDGED state first before the ACKNOWLEDGED state.
        if (state === UNACKNOWLEDGED) return

        try {
          assert.strictEqual(id, configId)
          assert.strictEqual(version, 1)
          assert.strictEqual(state, ACKNOWLEDGED)
          assert.ok(!error) // falsy check since error will be an empty string, but that's an implementation detail

          receivedAckUpdate = true
          endIfDone()
        } catch (err) {
          done(err)
        }
      })

      // Add UFC config via Remote Config
      agent.addRemoteConfig({
        product: RC_PRODUCT,
        id: configId,
        config: ufcPayloads.simpleStringFlagForAck
      })

      // Trigger request to start remote config polling
      fetch(`${proc.url}/`).catch(done)

      let testCompleted = false
      function endIfDone () {
        if (receivedAckUpdate && !testCompleted) {
          testCompleted = true
          done()
        }
      }
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
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: 'false'
        }
      })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should handle disabled flagging provider gracefully', async () => {
      const response = await fetch(`${proc.url}/evaluate-flags`)
      assert.strictEqual(response.status, 200)
      const data = await response.json()
      // When provider is disabled, it uses noop provider which returns default values
      assert.strictEqual(data.results.boolean, false)
      assert.strictEqual(data.results.string, 'default')
      assert.strictEqual(data.evaluationsCompleted, 2)
    })
  })
})

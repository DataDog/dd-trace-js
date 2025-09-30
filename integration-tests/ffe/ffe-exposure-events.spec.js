'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../helpers')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')
const { UNACKNOWLEDGED, ACKNOWLEDGED } = require('../../packages/dd-trace/src/remote_config/apply_states')
const ufcPayloads = require('./fixtures/ufc-payloads')
const RC_PRODUCT = 'FFE_FLAGS'

// Helper function to check exposure event structure
function validateExposureEvent (event, expectedFlag, expectedUser, expectedAttributes = {}) {
  assert.property(event, 'timestamp')
  assert.property(event, 'flag')
  assert.property(event, 'variant')
  assert.property(event, 'subject')

  assert.equal(event.flag.key, expectedFlag)
  assert.equal(event.subject.id, expectedUser)

  if (Object.keys(expectedAttributes).length > 0) {
    assert.deepEqual(event.subject.attributes, expectedAttributes)
  }

  assert.isNumber(event.timestamp)
  assert.isTrue(Date.now() - event.timestamp < 10000) // Within last 10 seconds
}

describe('FFE Remote Config and Exposure Events Integration', () => {
  let axios, sandbox, cwd, appFile

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    // Dependencies needed for OpenFeature integration tests
    const dependencies = [
      'express',
      '@openfeature/server-sdk',
      '@openfeature/core',
    ]

    sandbox = await createSandbox(
      dependencies,
      false,
      [path.join(__dirname, 'app')]
    )

    cwd = sandbox.folder
    appFile = path.join(cwd, 'app', 'exposure-events.js')
  })

  after(async function () {
    this.timeout(60000)
    await sandbox.remove()
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
            DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: 0.1,
            DD_FLAGGING_PROVIDER_ENABLED: true
          }
        })
        axios = Axios.create({ baseURL: proc.url })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('should generate exposure events with manual flush', (done) => {
        const configId = 'org-42-env-test'
        const exposureEvents = []

        // Listen for exposure events
        agent.on('exposures', ({ payload, headers }) => {
          assert.property(payload, 'context')
          assert.property(payload, 'exposures')
          assert.equal(payload.context.service_name, 'ffe-test-service')
          assert.equal(payload.context.version, '1.2.3')
          assert.equal(payload.context.env, 'test')

          exposureEvents.push(...payload.exposures)

          if (exposureEvents.length === 2) {
            try {
              assert.equal(headers['content-type'], 'application/json')
              assert.equal(headers['x-datadog-evp-subdomain'], 'event-platform-intake')

              // Verify we got exposure events from flag evaluations
              assert.equal(exposureEvents.length, 2)

              const booleanEvent = exposureEvents.find(e => e.flag.key === 'test-boolean-flag')
              const stringEvent = exposureEvents.find(e => e.flag.key === 'test-string-flag')

              assert.ok(booleanEvent, 'Should have boolean flag exposure')
              assert.ok(stringEvent, 'Should have string flag exposure')

              // Verify exposure event structure using helper
              validateExposureEvent(booleanEvent, 'test-boolean-flag', 'test-user-123',
                { user: 'test-user-123', plan: 'premium' })
              validateExposureEvent(stringEvent, 'test-string-flag', 'test-user-456',
                { user: 'test-user-456', tier: 'enterprise' })

              done()
            } catch (error) {
              done(error)
            }
          }
        })

        // Deliver UFC config via Remote Config
        agent.addRemoteConfig({
          product: RC_PRODUCT,
          id: configId,
          config: { flag_configuration: ufcPayloads.testBooleanAndStringFlags }
        })

        // Wait for RC delivery then evaluate flags
        setTimeout(async () => {
          try {
            const response = await axios.get('/evaluate-flags')
            assert.equal(response.status, 200)
            assert.equal(response.data.evaluationsCompleted, 2)

            // Trigger manual flush to send exposure events
            await axios.get('/flush')
          } catch (error) {
            done(error)
          }
        }, 1000)
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
            DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: 0.1,
            DD_FLAGGING_PROVIDER_ENABLED: true,
            _DD_FFE_FLUSH_INTERVAL: 100 // 100ms for fast testing
          }
        })
        axios = Axios.create({ baseURL: proc.url })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('should handle multiple flag evaluations with automatic flush', (done) => {
        const configId = 'org-42-env-test'
        const exposureEvents = []

        agent.on('exposures', ({ payload }) => {
          assert.property(payload, 'context')
          assert.property(payload, 'exposures')
          assert.equal(payload.context.service_name, 'ffe-test-service')
          assert.equal(payload.context.version, '1.2.3')
          assert.equal(payload.context.env, 'test')

          exposureEvents.push(...payload.exposures)

          if (exposureEvents.length >= 6) {
            try {
              assert.equal(exposureEvents.length, 6)

              const booleanEvents = exposureEvents.filter(e => e.flag.key === 'test-boolean-flag')
              const stringEvents = exposureEvents.filter(e => e.flag.key === 'test-string-flag')

              assert.equal(booleanEvents.length, 3)
              assert.equal(stringEvents.length, 3)

              // Verify different users
              const userIds = [...new Set(exposureEvents.map(e => e.subject.id))]
              assert.equal(userIds.length, 3)
              assert.include(userIds, 'user-1')
              assert.include(userIds, 'user-2')
              assert.include(userIds, 'user-3')

              done()
            } catch (error) {
              done(error)
            }
          }
        })

        agent.addRemoteConfig({
          product: RC_PRODUCT,
          id: configId,
          config: { flag_configuration: ufcPayloads.testBooleanAndStringFlags }
        })

        setTimeout(async () => {
          try {
            const response = await axios.get('/evaluate-multiple-flags')
            assert.equal(response.status, 200)
            assert.equal(response.data.evaluationsCompleted, 6)

          // No manual flush - let automatic flush handle it (100ms interval)
          } catch (error) {
            done(error)
          }
        }, 300)
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
          DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: 0.1,
          DD_FLAGGING_PROVIDER_ENABLED: true,
          _DD_FFE_FLUSH_INTERVAL: 100 // 100ms for fast testing
        }
      })
      axios = Axios.create({ baseURL: proc.url })
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
          assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

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
        config: { flag_configuration: ufcPayloads.simpleStringFlagForAck }
      })

      // Trigger request to start remote config polling
      axios.get('/').then(() => {
        // Wait for remote config processing
        setTimeout(endIfDone, 200)
      }).catch(done)

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
          DD_FLAGGING_PROVIDER_ENABLED: false
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should handle disabled flagging provider gracefully', async () => {
      try {
        await axios.get('/evaluate-flags')
        throw new Error('Expected request to fail')
      } catch (error) {
        if (error.response) {
          assert.equal(error.response.status, 500)
          assert.equal(error.response.data.error, 'OpenFeature client not available')
        } else {
          // Handle cases where there's no response (connection errors, etc.)
          assert.include(error.message, 'Expected request to fail')
        }
      }
    })
  })
})

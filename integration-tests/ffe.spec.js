'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('./helpers')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')
const ufcPayloads = require('./ffe/fixtures/ufc-payloads')
const { UNACKNOWLEDGED, ACKNOWLEDGED } = require('../packages/dd-trace/src/remote_config/apply_states')
const FFE_FLAG_CONFIGURATION_RULES = 'FFE_FLAG_CONFIGURATION_RULES'

describe('FFE Remote Configuration', () => {
  let axios, sandbox, cwd, appFile

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['express'],
      false,
      [path.join(__dirname, 'ffe')]
    )

    cwd = sandbox.folder
    appFile = path.join(cwd, 'ffe', 'index.js')
  })

  after(async function () {
    this.timeout(60000)
    await sandbox.remove()
  })

  describe('UFC delivery via remote config', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: 0.1,
          DD_FFE_ENABLED: true
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should set UFC configuration', function (done) {
      const configId = 'org-42-env-test'
      let receivedAckUpdate = false

      agent.on('remote-config-ack-update', (id, version, state, error) => {
        // Due to the very short DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS, there's a race condition in which we might
        // get an UNACKNOWLEDGED state first before the ACKNOWLEDGED state.
        if (state === UNACKNOWLEDGED) return

        assert.strictEqual(id, configId)
        assert.strictEqual(version, 1)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.notOk(error) // falsy check since error will be an empty string, but that's an implementation detail

        receivedAckUpdate = true
        endIfDone()
      })

      // Add UFC config using fixture
      agent.addRemoteConfig({
        product: FFE_FLAG_CONFIGURATION_RULES,
        id: configId,
        config: ufcPayloads.simpleStringFlag
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
          // Verify FFE config was applied
          axios.get('/ffe/config').then((response) => {
            assert.equal(response.status, 200)
            assert.ok(response.data.config)
            assert.ok(response.data.config[configId])
            assert.deepStrictEqual(response.data.config[configId], ufcPayloads.simpleStringFlag)
            done()
          }).catch(done)
        }
      }
    })

    it('should remove UFC configuration', function (done) {
      const configId = 'org-42-env-test'
      let receivedAckUpdate = false
      let configRemoved = false

      agent.on('remote-config-ack-update', (id, version, state, error) => {
        if (state === UNACKNOWLEDGED) return

        assert.strictEqual(id, configId)
        assert.strictEqual(version, 1)
        assert.strictEqual(state, ACKNOWLEDGED)
        assert.notOk(error)

        receivedAckUpdate = true
        if (!configRemoved) {
          // Remove config after acknowledgment
          agent.removeRemoteConfig(configId)
          configRemoved = true
          axios.get('/').then(() => {
            // Wait a bit for removal processing
            setTimeout(endIfDone, 200)
          }).catch(done)
        }
      })

      // Add then remove config using fixture
      agent.addRemoteConfig({
        product: FFE_FLAG_CONFIGURATION_RULES,
        id: configId,
        config: ufcPayloads.simpleStringFlag
      })

      axios.get('/').catch(done)

      let testCompleted = false
      function endIfDone () {
        if (receivedAckUpdate && configRemoved && !testCompleted) {
          testCompleted = true
          // Verify config was removed
          axios.get('/ffe/config').then((response) => {
            assert.equal(response.status, 200)
            assert.ok(response.data.config)
            assert.notOk(response.data.config[configId])
            done()
          }).catch(done)
        }
      }
    })
  })
})

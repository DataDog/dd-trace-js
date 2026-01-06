'use strict'

const assert = require('node:assert/strict')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('./helpers')
const path = require('path')
const Axios = require('axios')
describe('Remote config client id', () => {
  let axios, cwd, appFile

  useSandbox(
    ['express'],
    false,
    [path.join(__dirname, 'remote_config')]
  )

  before(function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'remote_config', 'index.js')
  })

  describe('enabled', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should add client_id tag when remote config is enabled', async () => {
      await axios.get('/')

      return agent.assertMessageReceived(({ payload }) => {
        assert.ok(payload[0][0].meta['_dd.rc.client_id'])
      })
    })

    it('should include process tags in remote config requests', (done) => {
      const handleRemoteConfigRequest = (payload) => {
        try {
          const { client } = payload
          assert.ok(client, 'client should exist in remote config request')
          assert.ok(client.client_tracer, 'client_tracer should exist')
          assert.ok(client.client_tracer.process_tags, 'process_tags should exist')

          const processTags = client.client_tracer.process_tags

          // Verify process_tags is an object
          assert.strictEqual(typeof processTags, 'object')

          // Verify required process tags are present
          assert.ok('entrypoint.basedir' in processTags)
          assert.ok('entrypoint.name' in processTags)
          assert.ok('entrypoint.type' in processTags)
          assert.ok('entrypoint.workdir' in processTags)

          // Verify entrypoint.type has the expected value
          assert.strictEqual(processTags['entrypoint.type'], 'script')

          // Verify values are strings (not undefined)
          assert.strictEqual(typeof processTags['entrypoint.name'], 'string')
          assert.strictEqual(typeof processTags['entrypoint.workdir'], 'string')
          assert.strictEqual(typeof processTags['entrypoint.basedir'], 'string')
          done()
        } catch (err) {
          done(err)
        } finally {
          agent.removeListener('remote-config-request', handleRemoteConfigRequest)
        }
      }

      agent.on('remote-config-request', handleRemoteConfigRequest)

      // Trigger a request to ensure remote config is polled
      axios.get('/').catch(() => {})
    })
  })

  describe('disabled', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_REMOTE_CONFIGURATION_ENABLED: 'false'
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should not add client_id tag when remote config is disbaled', async () => {
      await axios.get('/')

      return agent.assertMessageReceived(({ payload }) => {
        assert.ok(payload[0][0].meta['_dd.rc.client_id'] == null)
      })
    })
  })
})

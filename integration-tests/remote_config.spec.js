'use strict'

const assert = require('node:assert/strict')

const path = require('path')
const Axios = require('axios')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('./helpers')
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
        },
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

          // Verify process_tags is an array of strings
          assert.ok(Array.isArray(processTags), 'process_tags should be an array')

          // Verify required process tags are present
          assert.ok(processTags.some(tag => tag.startsWith('entrypoint.basedir:')))
          assert.ok(processTags.some(tag => tag.startsWith('entrypoint.name:')))
          assert.ok(processTags.some(tag => tag.startsWith('entrypoint.type:')))
          assert.ok(processTags.some(tag => tag.startsWith('entrypoint.workdir:')))

          // Verify entrypoint.type has the expected value
          assert.ok(processTags.some(tag => tag === 'entrypoint.type:script'))
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
          DD_REMOTE_CONFIGURATION_ENABLED: 'false',
        },
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

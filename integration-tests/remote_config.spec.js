'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')
const { inspect } = require('node:util')

const Axios = require('axios')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc } = require('./helpers')

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
      await stopProc(proc)
      await agent.stop()
    })

    it('should add client_id tag when remote config is enabled', async () => {
      await axios.get('/')

      return agent.assertMessageReceived(({ payload }) => {
        assert.ok(payload[0][0].meta['_dd.rc.client_id'])
      })
    })

    it('should include process tags in remote config requests', async () => {
      const request = once(agent, 'remote-config-request')
      // Trigger a request to ensure remote config is polled
      await axios.get('/')
      const [{ client }] = await request

      assert.ok(client, 'client should exist in remote config request')
      assert.ok(client.client_tracer, 'client_tracer should exist')
      assert.ok(client.client_tracer.process_tags, 'process_tags should exist')

      const processTags = client.client_tracer.process_tags

      assert.ok(Array.isArray(processTags), 'process_tags should be an array')
      assert.ok(processTags.some(tag => tag.startsWith('entrypoint.basedir:')), `Got: ${inspect(processTags)}`)
      assert.ok(processTags.some(tag => tag.startsWith('entrypoint.name:')), `Got: ${inspect(processTags)}`)
      assert.ok(processTags.some(tag => tag.startsWith('entrypoint.type:')), `Got: ${inspect(processTags)}`)
      assert.ok(processTags.some(tag => tag.startsWith('entrypoint.workdir:')), `Got: ${inspect(processTags)}`)
      assert.ok(processTags.some(tag => tag === 'entrypoint.type:script'), `Got: ${inspect(processTags)}`)
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
      await stopProc(proc)
      await agent.stop()
    })

    it('should not add client_id tag when remote config is disbaled', async () => {
      await axios.get('/')

      return agent.assertMessageReceived(({ payload }) => {
        assert.ok(
          payload[0][0].meta['_dd.rc.client_id'] == null,
          `Expected ${payload[0][0].meta['_dd.rc.client_id']} == null`
        )
      })
    })
  })
})

'use strict'

const { assert } = require('chai')
const path = require('path')
const Axios = require('axios')

const {
  createSandbox,
  FakeAgent,
  spawnProc
} = require('../helpers')

describe('ASM Trace Tagging rules', () => {
  let axios, sandbox, cwd, appFile, agent, proc

  function startServer () {
    beforeEach(async () => {
      agent = await new FakeAgent().start()

      const env = {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: true,
        DD_APPSEC_RULES: path.join(cwd, 'appsec', 'data-collection', 'data-collection-rules.json')
      }

      proc = await spawnProc(appFile, { cwd, env, execArgv: [] })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })
  }

  describe('express', () => {
    before(async () => {
      sandbox = await createSandbox(['express'])
      cwd = sandbox.folder
      appFile = path.join(cwd, 'appsec/data-collection/index.js')
    })

    after(async () => {
      await sandbox.remove()
    })

    startServer()

    it('should report waf attributes', async () => {
      await axios.get('/', { headers: { 'User-Agent': 'TraceTaggingTest/v1' } })

      await agent.assertMessageReceived(({ _, payload }) => {
        assert.property(payload[0][0].meta, '_dd.appsec.trace.agent')
        assert.strictEqual(payload[0][0].meta['_dd.appsec.trace.agent'], 'TraceTaggingTest/v1')
        assert.property(payload[0][0].metrics, '_dd.appsec.trace.integer')
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.trace.integer'], 1234)
      })
    })
  })

  describe('fastify', () => {
    before(async () => {
      sandbox = await createSandbox(['fastify'])
      cwd = sandbox.folder
      appFile = path.join(cwd, 'appsec/data-collection/fastify.js')
    })

    after(async () => {
      await sandbox.remove()
    })

    startServer()

    it('should report waf attributes', async () => {
      let fastifyRequestReceived = false

      await axios.get('/', { headers: { 'User-Agent': 'TraceTaggingTest/v1' } })

      await agent.assertMessageReceived(({ _, payload }) => {
        if (payload[0][0].name !== 'fastify.request') {
          throw new Error('Not the span we are looking for')
        }

        fastifyRequestReceived = true

        assert.property(payload[0][0].meta, '_dd.appsec.trace.agent')
        assert.strictEqual(payload[0][0].meta['_dd.appsec.trace.agent'], 'TraceTaggingTest/v1')
        assert.property(payload[0][0].metrics, '_dd.appsec.trace.integer')
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.trace.integer'], 1234)
      }, 30000, 10, true)

      assert.isTrue(fastifyRequestReceived)
    })
  })
})

'use strict'

const assert = require('node:assert/strict')
const path = require('path')
const Axios = require('axios')

const {
  sandboxCwd,
  useSandbox,
  FakeAgent,
  spawnProc
} = require('../helpers')

describe('Headers collection - Fastify', () => {
  let axios, cwd, appFile, agent, proc

  useSandbox(['fastify'])

  before(() => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'appsec/data-collection/fastify.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()

    const env = {
      DD_TRACE_AGENT_PORT: agent.port,
      DD_APPSEC_ENABLED: 'true',
      DD_APPSEC_RULES: path.join(cwd, 'appsec/data-collection/data-collection-rules.json')
    }
    proc = await spawnProc(appFile, { cwd, env, execArgv: [] })
    axios = Axios.create({ baseURL: proc.url })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('should collect response headers with Fastify', async () => {
    let fastifyRequestReceived = false
    const requestHeaders = [
      'user-agent',
      'accept',
      'host',
      'accept-encoding'
    ]

    const responseHeaders = [
      'content-type',
      'content-language',
      'content-length'
    ]

    await axios.get('/', {
      headers: { 'User-Agent': 'Arachni/v1' }
    })

    await agent.assertMessageReceived(({ headers, payload }) => {
      if (payload[0][0].name !== 'fastify.request') {
        throw new Error('Not the span we are looking for')
      }

      fastifyRequestReceived = true
      assert.equal(
        Object.keys(payload[0][0].meta).filter(tagName => tagName.startsWith('http.request.headers.')).length,
        requestHeaders.length
      )
      requestHeaders.forEach((headerName) => {
        assert.ok(Object.hasOwn(payload[0][0].meta, `http.request.headers.${headerName}`))
      })

      // Response headers
      assert.equal(
        Object.keys(payload[0][0].meta).filter(tagName => tagName.startsWith('http.response.headers.')).length,
        responseHeaders.length
      )
      responseHeaders.forEach((headerName) => {
        assert.ok(Object.hasOwn(payload[0][0].meta, `http.response.headers.${headerName}`))
      })
    }, 30000, 10, true)

    assert.strictEqual(fastifyRequestReceived, true)
  })
})

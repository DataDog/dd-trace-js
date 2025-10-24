'use strict'

const { assert } = require('chai')
const path = require('path')
const Axios = require('axios')

const {
  isolatedSandbox,
  FakeAgent,
  spawnProc
} = require('../helpers')

describe('ASM Data collection', () => {
  let axios, sandbox, cwd, appFile, agent, proc

  before(async () => {
    sandbox = await isolatedSandbox(['express'])
    cwd = sandbox.folder
    appFile = path.join(cwd, 'appsec/data-collection/index.js')
  })

  after(async () => {
    await sandbox.remove()
  })

  function startServer (extendedDataCollection) {
    beforeEach(async () => {
      agent = await new FakeAgent().start()

      const env = {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: true,
        DD_APPSEC_RULES: path.join(cwd, 'appsec', 'data-collection', 'data-collection-rules.json')
      }

      if (extendedDataCollection) {
        env.DD_APPSEC_COLLECT_ALL_HEADERS = true
        env.DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED = false
        env.DD_APPSEC_MAX_COLLECTED_HEADERS = 25
      }

      proc = await spawnProc(appFile, { cwd, env, execArgv: [] })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })
  }

  async function assertHeadersReported (requestHeaders, responseHeaders) {
    await agent.assertMessageReceived(({ headers, payload }) => {
      // Request headers
      assert.equal(
        Object.keys(payload[0][0].meta).filter(tagName => tagName.startsWith('http.request.headers.')).length,
        requestHeaders.length
      )
      requestHeaders.forEach((headerName) => {
        assert.property(payload[0][0].meta, `http.request.headers.${headerName}`)
      })

      // Response headers
      assert.equal(
        Object.keys(payload[0][0].meta).filter(tagName => tagName.startsWith('http.response.headers.')).length,
        responseHeaders.length
      )
      responseHeaders.forEach((headerName) => {
        assert.property(payload[0][0].meta, `http.response.headers.${headerName}`)
      })
    })
  }

  describe('Basic data collection', () => {
    startServer(false)

    it('should collect event headers', async () => {
      const expectedRequestHeaders = [
        'user-agent',
        'accept',
        'host',
        'accept-encoding'
      ]

      const expectedResponseHeaders = [
        'content-type',
        'content-language'
      ]

      await axios.get('/', { headers: { 'User-Agent': 'Arachni/v1' } })
      await assertHeadersReported(expectedRequestHeaders, expectedResponseHeaders)
    })
  })

  describe('Extended data collection', () => {
    startServer(true)

    it('should collect extended headers', async () => {
      const expectedRequestHeaders = [
        'user-agent',
        'accept',
        'host',
        'accept-encoding',
        'connection'
      ]

      // DD_APPSEC_MAX_COLLECTED_HEADERS is set to 25, so it is expected to collect
      // 22 x-datadog-res-XX headers + x-powered-by, content-type and content-language, for a total of 25.
      const expectedResponseHeaders = [
        ...Array.from({ length: 22 }, (_, i) =>
          `x-datadog-res-${i}`
        ),
        'x-powered-by',
        'content-type',
        'content-language'
      ]

      await axios.get('/', { headers: { 'User-Agent': 'Arachni/v1' } })
      await assertHeadersReported(expectedRequestHeaders, expectedResponseHeaders)
    })
  })
})

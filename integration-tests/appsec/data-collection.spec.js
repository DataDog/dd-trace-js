'use strict'

const { assert } = require('chai')
const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')

const {
  createSandbox,
  FakeAgent,
  spawnProc
} = require('../helpers')

describe('ASM Data collection', () => {
  let axios, sandbox, cwd, appPort, appFile, agent, proc

  before(async () => {
    sandbox = await createSandbox(['express'])
    appPort = await getPort()
    cwd = sandbox.folder
    appFile = path.join(cwd, 'appsec/data-collection/index.js')
    axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  after(async () => {
    await sandbox.remove()
  })

  function startServer (extendedDataCollection) {
    beforeEach(async () => {
      agent = await new FakeAgent().start()

      const env = {
        APP_PORT: appPort,
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
        Object.keys(requestHeaders).length
      )
      Object.entries(requestHeaders).forEach(([headerName, headerValue]) => {
        assert.equal(payload[0][0].meta[`http.request.headers.${headerName}`], headerValue)
      })

      // Response headers
      assert.equal(
        Object.keys(payload[0][0].meta).filter(tagName => tagName.startsWith('http.response.headers.')).length,
        Object.keys(responseHeaders).length
      )
      Object.entries(responseHeaders).forEach(([headerName, headerValue]) => {
        assert.equal(payload[0][0].meta[`http.response.headers.${headerName}`], headerValue)
      })
    })
  }

  describe('Basic data collection', () => {
    startServer(false)

    it('should collect event headers', async () => {
      const expectedRequestHeaders = {
        'user-agent': 'Arachni/v1',
        accept: 'application/json, text/plain, */*',
        host: `localhost:${appPort}`,
        'accept-encoding': 'gzip, compress, deflate, br'
      }

      const expectedResponseHeaders = {
        'content-type': 'text/plain; charset=utf-8',
        'content-language': 'en'
      }

      await axios.get('/', { headers: { 'User-Agent': 'Arachni/v1' } })
      await assertHeadersReported(expectedRequestHeaders, expectedResponseHeaders)
    })
  })

  describe('Extended data collection', () => {
    startServer(true)

    it('should collect extended headers', async () => {
      const expectedRequestHeaders = {
        'user-agent': 'Arachni/v1',
        accept: 'application/json, text/plain, */*',
        host: `localhost:${appPort}`,
        'accept-encoding': 'gzip, compress, deflate, br',
        connection: 'keep-alive'
      }

      const expectedResponseHeaders = {
        ...Object.fromEntries(
          Array.from({ length: 22 }, (_, i) =>
            [`x-datadog-res-${i}`, `ext-res-${i}`]
          )
        ),
        'x-powered-by': 'Express',
        'content-type': 'text/plain; charset=utf-8',
        'content-language': 'en'
      }

      await axios.get('/', { headers: { 'User-Agent': 'Arachni/v1' } })
      await assertHeadersReported(expectedRequestHeaders, expectedResponseHeaders)
    })
  })
})

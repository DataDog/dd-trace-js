'use strict'

const assert = require('node:assert/strict')
const path = require('path')
const { inspect } = require('node:util')
const Axios = require('axios')

const {
  sandboxCwd,
  useSandbox,
  FakeAgent,
  spawnProc,
  stopProc,
} = require('../helpers')

describe('AppSec headers collection - Express', () => {
  let axios, cwd, appFile, agent, proc

  useSandbox(['express'])

  before(async () => {
    cwd = sandboxCwd()
  })

  function startServer (app, { extendedDataCollection = false } = {}) {
    beforeEach(async () => {
      appFile = path.join(cwd, app)
      agent = await new FakeAgent().start()

      const env = {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: 'true',
        DD_APPSEC_RULES: path.join(cwd, 'appsec', 'data-collection', 'data-collection-rules.json'),
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
      await stopProc(proc)
      await agent.stop()
    })
  }

  async function assertHeadersReported (requestHeaders, responseHeaders) {
    await agent.assertMessageReceived(({ payload }) => {
      // Request headers
      assert.equal(
        Object.keys(payload[0][0].meta).filter(tagName => tagName.startsWith('http.request.headers.')).length,
        requestHeaders.length
      )
      requestHeaders.forEach((headerName) => {
        assert.ok(
          Object.hasOwn(payload[0][0].meta, `http.request.headers.${headerName}`),
          `Available keys: ${inspect(Object.keys(payload[0][0].meta))}`
        )
      })

      // Response headers
      assert.equal(
        Object.keys(payload[0][0].meta).filter(tagName => tagName.startsWith('http.response.headers.')).length,
        responseHeaders.length
      )
      responseHeaders.forEach((headerName) => {
        assert.ok(
          Object.hasOwn(payload[0][0].meta, `http.response.headers.${headerName}`),
          `Available keys: ${inspect(Object.keys(payload[0][0].meta))}`
        )
      })
    })
  }

  describe('Basic data collection (event-driven)', () => {
    startServer('appsec/data-collection/index.js')

    it('should collect event headers when a WAF event is triggered', async () => {
      const expectedRequestHeaders = ['user-agent', 'accept', 'host', 'accept-encoding']
      const expectedResponseHeaders = ['content-type', 'content-language']

      await axios.get('/', { headers: { 'User-Agent': 'Arachni/v1' } })
      await assertHeadersReported(expectedRequestHeaders, expectedResponseHeaders)
    })
  })

  describe('Extended data collection (event-driven)', () => {
    startServer('appsec/data-collection/index.js', { extendedDataCollection: true })

    it('should collect extended headers when a WAF event is triggered', async () => {
      const expectedRequestHeaders = ['user-agent', 'accept', 'host', 'accept-encoding', 'connection']

      // DD_APPSEC_MAX_COLLECTED_HEADERS is set to 25, so it is expected to collect
      // 22 x-datadog-res-XX headers + x-powered-by, content-type and content-language, for a total of 25.
      const expectedResponseHeaders = [
        ...Array.from({ length: 22 }, (_, i) => `x-datadog-res-${i}`),
        'x-powered-by',
        'content-type',
        'content-language',
      ]

      await axios.get('/', { headers: { 'User-Agent': 'Arachni/v1' } })
      await assertHeadersReported(expectedRequestHeaders, expectedResponseHeaders)
    })
  })

  describe('No security event', () => {
    startServer('appsec/response-headers/express.js')

    it('should always collect content-type and content-length response headers when AppSec is enabled', async () => {
      const response = await axios.get('/', { headers: { 'User-Agent': 'Mozilla/5.0' } })

      assert.equal(response.status, 200)
      assert.ok(response.headers['content-type'])
      assert.ok(response.headers['content-length'])

      await agent.assertMessageReceived(({ payload }) => {
        const span = payload[0]?.find(s => s.type === 'web')
        if (!span) throw new Error('web-type span not yet received')

        assert.equal(span.meta['http.response.headers.content-type'], response.headers['content-type'])
        assert.equal(span.meta['http.response.headers.content-length'], response.headers['content-length'])
        assert.equal(span.meta['appsec.event'], undefined)
      })
    })
  })
})

describe('AppSec headers collection - Fastify', () => {
  let axios, cwd, appFile, agent, proc

  useSandbox(['fastify'])

  before(() => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'appsec/response-headers/fastify.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: 'true',
      },
      execArgv: [],
    })
    axios = Axios.create({ baseURL: proc.url })
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  describe('No security event', () => {
    it('should always emit content-type and content-length response headers when AppSec is enabled', async () => {
      const response = await axios.get('/', { headers: { 'User-Agent': 'Mozilla/5.0' } })

      assert.equal(response.status, 200)
      assert.ok(response.headers['content-type'])
      assert.ok(response.headers['content-length'])

      await agent.assertMessageReceived(({ payload }) => {
        const span = payload[0]?.find(s => s.type === 'web')
        if (!span) throw new Error('web-type span not yet received')

        assert.equal(span.meta['http.response.headers.content-type'], response.headers['content-type'])
        assert.equal(span.meta['http.response.headers.content-length'], response.headers['content-length'])
        assert.equal(span.meta['appsec.event'], undefined)
      })
    })
  })
})

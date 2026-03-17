'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const Axios = require('axios')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../../../../integration-tests/helpers')
const { calculateHttpEndpoint } = require('../../src/plugins/util/url')

describe('API Security sampling integration', () => {
  let cwd
  let appFile
  let rulesFile

  useSandbox(
    ['express', 'body-parser'],
    false,
    [path.join(__dirname, 'resources')]
  )

  before(() => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'resources', 'api_security_sampling-app.js')
    rulesFile = path.join(__dirname, 'api_security_rules.json')
  })

  function findSpanBy (payload, predicate) {
    for (const trace of payload) {
      for (const span of trace) {
        if (predicate(span)) {
          return span
        }
      }
    }

    throw new Error('No matching span found in payload')
  }

  describe('route and endpoint fallback sampling', () => {
    let agent
    let proc
    let axios

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_APPSEC_ENABLED: 'true',
          DD_API_SECURITY_ENABLED: 'true',
          DD_API_SECURITY_SAMPLE_DELAY: '10',
          DD_TRACE_RESOURCE_RENAMING_ENABLED: 'true',
          DD_APPSEC_RULES: rulesFile,
        },
      })

      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('samples first express route request only', async () => {
      const firstMessage = agent.assertMessageReceived(({ payload }) => {
        const span = findSpanBy(payload, span => span.meta?.['http.route'] === '/api_security_sampling/:i')
        assert.ok(Object.hasOwn(span.meta, '_dd.appsec.s.req.body'))
      }, 10_000)

      await axios.post('/api_security_sampling/1', { key: 'value' })
      await firstMessage

      const secondMessage = agent.assertMessageReceived(({ payload }) => {
        const span = findSpanBy(payload, span => span.meta?.['http.route'] === '/api_security_sampling/:i')
        assert.ok(!Object.hasOwn(span.meta, '_dd.appsec.s.req.body'))
      }, 10_000)

      await axios.post('/api_security_sampling/2', { key: 'value' })
      await secondMessage
    })

    it('samples first endpoint-fallback request only when route is missing', async () => {
      const expectedEndpoint = calculateHttpEndpoint('http://localhost/api_security_sampling_resource_renaming/101')

      const firstMessage = agent.assertMessageReceived(({ payload }) => {
        const span = findSpanBy(payload, span => span.meta?.['http.endpoint'] === expectedEndpoint)
        assert.ok(Object.hasOwn(span.meta, '_dd.appsec.s.req.body'))
      }, 10_000)

      await axios.post('/api_security_sampling_resource_renaming/101', { key: 'value' })
      await firstMessage

      const secondMessage = agent.assertMessageReceived(({ payload }) => {
        const span = findSpanBy(payload, span => span.meta?.['http.endpoint'] === expectedEndpoint)
        assert.ok(!Object.hasOwn(span.meta, '_dd.appsec.s.req.body'))
      }, 10_000)

      await axios.post('/api_security_sampling_resource_renaming/202', { key: 'value' })
      await secondMessage
    }).timeout(20_000)
  })
})

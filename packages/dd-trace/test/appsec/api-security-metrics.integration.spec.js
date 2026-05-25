'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const Axios = require('axios')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc } = require('../../../../integration-tests/helpers')

describe('API Security Telemetry metrics', () => {
  let cwd, appFile, rulesFile

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

  describe('request schema', () => {
    let agent, proc, axios

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_APPSEC_ENABLED: 'true',
          DD_API_SECURITY_ENABLED: 'true',
          DD_API_SECURITY_SAMPLE_DELAY: '0',
          DD_APPSEC_RULES: rulesFile,
          DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        },
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    it('should emit api_security.request.schema with framework tag for sampled requests', async () => {
      let metricReceived = false

      await axios.post('/api_security_sampling/1', { key: 'value' })

      await agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          if (payload.payload.namespace !== 'appsec') return

          const schemaMetric = payload.payload.series.find(s => s.metric === 'api_security.request.schema')
          if (!schemaMetric) return

          assert.strictEqual(schemaMetric.type, 'count')
          assert.ok(
            schemaMetric.tags.includes('framework:express'),
            `expected request.schema tags to include framework:express, got ${JSON.stringify(schemaMetric.tags)}`
          )
          metricReceived = true
        },
        requestType: 'generate-metrics',
        expectedMessageCount: 2,
      })

      assert.strictEqual(metricReceived, true)
    }).timeout(20_000)
  })

  describe('missing route', () => {
    let agent, proc, axios

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_APPSEC_ENABLED: 'true',
          DD_API_SECURITY_ENABLED: 'true',
          DD_API_SECURITY_SAMPLE_DELAY: '0',
          DD_APPSEC_RULES: rulesFile,
          DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
          DD_TRACE_RESOURCE_RENAMING_ENABLED: 'false',
        },
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    it('should emit api_security.missing_route when no framework route is available', async () => {
      let metricReceived = false

      // This path is served by raw http.createServer, so express has no route registered.
      // With resource renaming disabled, there is also no http.endpoint fallback.
      await axios.post('/api_security_sampling_resource_renaming/1', { key: 'value' })

      await agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          if (payload.payload.namespace !== 'appsec') return

          const missingRouteMetric = payload.payload.series.find(s => s.metric === 'api_security.missing_route')
          if (!missingRouteMetric) return

          assert.strictEqual(missingRouteMetric.type, 'count')
          assert.ok(
            missingRouteMetric.tags.some(t => t.startsWith('framework:')),
            'missing_route metric should carry a framework tag'
          )
          metricReceived = true
        },
        requestType: 'generate-metrics',
        expectedMessageCount: 2,
      })

      assert.strictEqual(metricReceived, true)
    }).timeout(20_000)
  })
})

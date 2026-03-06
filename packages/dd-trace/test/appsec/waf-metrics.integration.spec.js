'use strict'

const assert = require('node:assert/strict')

const path = require('path')
const Axios = require('axios')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../../../../integration-tests/helpers')
describe('WAF Metrics', () => {
  let axios, cwd, appFile

  useSandbox(
    ['express'],
    false,
    [path.join(__dirname, 'resources')]
  )

  before(function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'resources', 'index.js')
  })

  describe('WAF error metrics', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_APPSEC_ENABLED: 'true',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
          DD_APPSEC_WAF_TIMEOUT: '0.1',
        },
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should report waf error metrics', async () => {
      let appsecTelemetryMetricsReceived = false

      const body = {
        name: 'hey',
      }

      await axios.post('/', body)

      const checkMessages = agent.assertMessageReceived(({ payload }) => {
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.enabled'], 1)
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.waf.error'], -127)
      })

      const checkTelemetryMetrics = agent.assertTelemetryReceived(({ payload }) => {
        const namespace = payload.payload.namespace

        if (namespace === 'appsec') {
          appsecTelemetryMetricsReceived = true
          const series = payload.payload.series
          const wafRequests = series.find(s => s.metric === 'waf.requests')

          assert.ok(wafRequests)
          assert.strictEqual(wafRequests.type, 'count')
          assert.ok(wafRequests.tags.includes('waf_error:true'))
          assert.ok(wafRequests.tags.includes('rate_limited:false'))

          const wafError = series.find(s => s.metric === 'waf.error')
          assert.ok(wafError)
          assert.strictEqual(wafError.type, 'count')
          assert.ok(wafError.tags.includes('waf_error:-127'))
        }
      }, 'generate-metrics', 30_000, 2)

      await Promise.all([checkMessages, checkTelemetryMetrics])

      assert.strictEqual(appsecTelemetryMetricsReceived, true)
    })
  })

  describe('WAF timeout metrics', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_APPSEC_ENABLED: 'true',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
          DD_APPSEC_WAF_TIMEOUT: '1',
        },
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should report waf timeout metrics', async () => {
      let appsecTelemetryMetricsReceived = false

      const complexPayload = createComplexPayload()
      await axios.post('/', { complexPayload })

      const checkMessages = agent.assertMessageReceived(({ payload }) => {
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.enabled'], 1)
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.waf.timeouts'] > 0, true)
      })

      const checkTelemetryMetrics = agent.assertTelemetryReceived(({ payload }) => {
        const namespace = payload.payload.namespace

        if (namespace === 'appsec') {
          appsecTelemetryMetricsReceived = true
          const series = payload.payload.series
          const wafRequests = series.find(s => s.metric === 'waf.requests')

          assert.ok(wafRequests)
          assert.strictEqual(wafRequests.type, 'count')
          assert.ok(wafRequests.tags.includes('waf_timeout:true'))
        }
      }, 'generate-metrics', 30_000, 2)

      await Promise.all([checkMessages, checkTelemetryMetrics])

      assert.strictEqual(appsecTelemetryMetricsReceived, true)
    })
  })

  describe('WAF truncation metrics', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_APPSEC_ENABLED: 'true',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        },
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should report truncation metrics', async () => {
      let appsecTelemetryMetricsReceived = false

      const complexPayload = createComplexPayload()
      await axios.post('/', { complexPayload })

      const checkMessages = agent.assertMessageReceived(({ payload }) => {
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.enabled'], 1)
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.truncated.container_depth'], 20)
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.truncated.container_size'], 300)
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.truncated.string_length'], 5000)
      })

      const checkTelemetryMetrics = agent.assertTelemetryReceived(({ payload }) => {
        const namespace = payload.payload.namespace

        if (namespace === 'appsec') {
          appsecTelemetryMetricsReceived = true
          const series = payload.payload.series
          const inputTruncated = series.find(s => s.metric === 'waf.input_truncated')

          assert.ok(inputTruncated)
          assert.strictEqual(inputTruncated.type, 'count')
          assert.ok(inputTruncated.tags.includes('truncation_reason:7'))

          const wafRequests = series.find(s => s.metric === 'waf.requests')
          assert.ok(wafRequests)
          assert.ok(wafRequests.tags.includes('input_truncated:true'))
        }
      }, 'generate-metrics', 30_000, 2)

      await Promise.all([checkMessages, checkTelemetryMetrics])

      assert.strictEqual(appsecTelemetryMetricsReceived, true)
    })
  })
})

const createComplexPayload = () => {
  const longValue = 'testattack'.repeat(500)
  const largeObject = {}
  for (let i = 0; i < 300; ++i) {
    largeObject[`key${i}`] = `value${i}`
  }
  const deepObject = createNestedObject(25, { value: 'a' })

  return {
    deepObject,
    longValue,
    largeObject,
  }
}

const createNestedObject = (n, obj) => {
  if (n > 0) {
    return { a: createNestedObject(n - 1, obj) }
  }
  return obj
}

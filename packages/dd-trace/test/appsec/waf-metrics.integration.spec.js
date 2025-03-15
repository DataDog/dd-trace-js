'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../integration-tests/helpers')
const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('WAF truncation metrics', () => {
  let axios, sandbox, cwd, appPort, appFile, agent, proc

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['express'],
      false,
      [path.join(__dirname, 'resources')]
    )

    appPort = await getPort()
    cwd = sandbox.folder
    appFile = path.join(cwd, 'resources', 'index.js')

    axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  after(async function () {
    this.timeout(60000)
    await sandbox.remove()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        APP_PORT: appPort,
        DD_APPSEC_ENABLED: 'true',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('should report tuncation metrics', async () => {
    let appsecTelemetryMetricsReceived = false
    let appsecTelemetryDistributionsReceived = false

    const longValue = 'testattack'.repeat(500)
    const largeObject = {}
    for (let i = 0; i < 300; ++i) {
      largeObject[`key${i}`] = `value${i}`
    }
    const deepObject = createNestedObject(25, { value: 'a' })
    const complexPayload = {
      deepObject,
      longValue,
      largeObject
    }

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

        assert.exists(inputTruncated, 'input truncated serie should exist')
        assert.strictEqual(inputTruncated.type, 'count')
        assert.include(inputTruncated.tags, 'truncation_reason:7')
      }
    }, 30_000, 'generate-metrics', 2)

    const checkTelemetryDistributions = agent.assertTelemetryReceived(({ payload }) => {
      const namespace = payload.payload.namespace

      if (namespace === 'appsec') {
        appsecTelemetryDistributionsReceived = true
        const series = payload.payload.series
        const wafDuration = series.find(s => s.metric === 'waf.duration')
        const wafDurationExt = series.find(s => s.metric === 'waf.duration_ext')
        const wafTuncated = series.filter(s => s.metric === 'waf.truncated_value_size')

        assert.exists(wafDuration, 'waf duration serie should exist')
        assert.exists(wafDurationExt, 'waf duration ext serie should exist')

        assert.equal(wafTuncated.length, 3)
        assert.include(wafTuncated[0].tags, 'truncation_reason:1')
        assert.include(wafTuncated[1].tags, 'truncation_reason:2')
        assert.include(wafTuncated[2].tags, 'truncation_reason:4')
      }
    }, 30_000, 'distributions', 1)

    return Promise.all([checkMessages, checkTelemetryMetrics, checkTelemetryDistributions]).then(() => {
      assert.equal(appsecTelemetryMetricsReceived, true)
      assert.equal(appsecTelemetryDistributionsReceived, true)

      return true
    })
  })
})

const createNestedObject = (n, obj) => {
  if (n > 0) {
    return { a: createNestedObject(n - 1, obj) }
  }
  return obj
}

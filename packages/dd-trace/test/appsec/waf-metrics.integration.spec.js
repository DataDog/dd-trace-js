'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../integration-tests/helpers')
const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('WAF error metrics', () => {
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
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        DD_APPSEC_WAF_TIMEOUT: 0.1
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('should report waf error metrics', async () => {
    let appsecTelemetryMetricsReceived = false

    const body = {
      name: 'hey'
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

        assert.exists(wafRequests, 'Waf requests serie should exist')
        assert.strictEqual(wafRequests.type, 'count')
        assert.include(wafRequests.tags, 'waf_error:true')
        assert.include(wafRequests.tags, 'rate_limited:true')
      }
    }, 30_000, 'generate-metrics', 2)

    return Promise.all([checkMessages, checkTelemetryMetrics]).then(() => {
      assert.equal(appsecTelemetryMetricsReceived, true)

      return true
    })
  })
})

describe('WAF timeout metrics', () => {
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
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        DD_APPSEC_WAF_TIMEOUT: 1
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('should report waf timeout metrics', async () => {
    let appsecTelemetryMetricsReceived = false

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
      assert.isTrue(payload[0][0].metrics['_dd.appsec.waf.timeouts'] > 0)
    })

    const checkTelemetryMetrics = agent.assertTelemetryReceived(({ payload }) => {
      const namespace = payload.payload.namespace

      if (namespace === 'appsec') {
        appsecTelemetryMetricsReceived = true
        const series = payload.payload.series
        const wafRequests = series.find(s => s.metric === 'waf.requests')

        assert.exists(wafRequests, 'Waf requests serie should exist')
        assert.strictEqual(wafRequests.type, 'count')
        assert.include(wafRequests.tags, 'waf_timeout:true')
      }
    }, 30_000, 'generate-metrics', 2)

    return Promise.all([checkMessages, checkTelemetryMetrics]).then(() => {
      assert.equal(appsecTelemetryMetricsReceived, true)

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

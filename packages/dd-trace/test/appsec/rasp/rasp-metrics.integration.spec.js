'use strict'

const assert = require('node:assert/strict')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')
const path = require('path')
const Axios = require('axios')
describe('RASP metrics', () => {
  let axios, cwd, appFile

  useSandbox(
    ['express'],
    false,
    [path.join(__dirname, 'resources')]
  )

  before(function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'resources', 'shi-app', 'index.js')
  })

  describe('RASP error metric', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_APPSEC_ENABLED: 'true',
          DD_APPSEC_RASP_ENABLED: 'true',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
          DD_APPSEC_RULES: path.join(cwd, 'resources', 'rasp_rules.json'),
          DD_APPSEC_WAF_TIMEOUT: 0.1
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should report rasp error metrics', async () => {
      try {
        await axios.get('/shi/execFileSync?dir=.')
      } catch (e) {
        if (!e.response) {
          throw e
        }
      }

      let appsecTelemetryMetricsReceived = false

      await agent.assertTelemetryReceived(({ payload }) => {
        const namespace = payload.payload.namespace

        if (namespace === 'appsec') {
          appsecTelemetryMetricsReceived = true
          const series = payload.payload.series
          const errorSerie = series.find(s => s.metric === 'rasp.error')

          assert.ok(errorSerie != null)
          assert.ok(errorSerie.tags.includes('waf_error:-127'))
          assert.strictEqual(errorSerie.type, 'count')
        }
      }, 'generate-metrics', 30_000, 2)

      assert.strictEqual(appsecTelemetryMetricsReceived, true)
    })
  })

  describe('RASP timeout metric', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_APPSEC_ENABLED: 'true',
          DD_APPSEC_RASP_ENABLED: 'true',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
          DD_APPSEC_WAF_TIMEOUT: 1
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should report rasp timeout metrics', async () => {
      await axios.get('/shi/execFileSync?dir=.')

      let appsecTelemetryReceived = false

      const checkMessages = agent.assertMessageReceived(({ payload }) => {
        assert.strictEqual(payload[0][0].metrics['_dd.appsec.rasp.timeout'] > 0, true)
      })

      const checkTelemetry = agent.assertTelemetryReceived(({ payload }) => {
        const namespace = payload.payload.namespace

        if (namespace === 'appsec') {
          appsecTelemetryReceived = true
          const series = payload.payload.series
          const timeoutSerie = series.find(s => s.metric === 'rasp.timeout')

          assert.ok(timeoutSerie != null)
          assert.ok(timeoutSerie.tags.includes('rule_type:command_injection'))
          assert.ok(timeoutSerie.tags.includes('rule_variant:shell'))
          assert.strictEqual(timeoutSerie.type, 'count')
        }
      }, 'generate-metrics', 30_000, 2)

      await Promise.all([checkMessages, checkTelemetry])

      assert.strictEqual(appsecTelemetryReceived, true)
    })
  })
})

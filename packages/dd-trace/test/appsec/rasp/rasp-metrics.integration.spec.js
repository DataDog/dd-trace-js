'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')
const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('RASP metrics', () => {
  let axios, sandbox, cwd, appPort, appFile

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['express'],
      false,
      [path.join(__dirname, 'resources')]
    )

    appPort = await getPort()
    cwd = sandbox.folder
    appFile = path.join(cwd, 'resources', 'shi-app', 'index.js')

    axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  after(async function () {
    this.timeout(60000)
    await sandbox.remove()
  })

  describe('RASP error metric', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          APP_PORT: appPort,
          DD_APPSEC_ENABLED: 'true',
          DD_APPSEC_RASP_ENABLED: 'true',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
          DD_APPSEC_RULES: path.join(cwd, 'resources', 'rasp_rules.json'),
          DD_APPSEC_WAF_TIMEOUT: 0.1
        }
      })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should report rasp error metrics', async () => {
      try {
        await axios.get('/shi/execFileSync?dir=$(cat /etc/passwd 1>%262 ; echo .)')
      } catch (e) {
        if (!e.response) {
          throw e
        }
      }

      let appsecTelemetryMetricsReceived = false

      return agent.assertTelemetryReceived(({ payload }) => {
        const namespace = payload.payload.namespace

        if (namespace === 'appsec') {
          appsecTelemetryMetricsReceived = true
          const series = payload.payload.series
          const errorSerie = series.find(s => s.metric === 'rasp.error')

          assert.exists(errorSerie, 'error serie should exist')
          assert.include(errorSerie.tags, 'waf_error:-127')
          assert.strictEqual(errorSerie.type, 'count')
        }
      }, 30_000, 'generate-metrics', 2).then(() => {
        assert.equal(appsecTelemetryMetricsReceived, true)
        return true
      })
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
          APP_PORT: appPort,
          DD_APPSEC_ENABLED: 'true',
          DD_APPSEC_RASP_ENABLED: 'true',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
          DD_APPSEC_WAF_TIMEOUT: 1
        }
      })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should report rasp timeout metrics', async () => {
      await axios.get('/shi/execFileSync?dir=$(cat /etc/passwd 1>%262 ; echo .)')

      let appsecTelemetryReceived = false

      const checkMessages = agent.assertMessageReceived(({ payload }) => {
        assert.isTrue(payload[0][0].metrics['_dd.appsec.rasp.timeout'] > 0)
      })

      const checkTelemetry = agent.assertTelemetryReceived(({ payload }) => {
        const namespace = payload.payload.namespace

        if (namespace === 'appsec') {
          appsecTelemetryReceived = true
          const series = payload.payload.series
          const timeoutSerie = series.find(s => s.metric === 'rasp.timeout')

          assert.exists(timeoutSerie, 'Timeout serie should exist')
          assert.include(timeoutSerie.tags, 'rule_type:command_injection')
          assert.include(timeoutSerie.tags, 'rule_variant:shell')
          assert.strictEqual(timeoutSerie.type, 'count')
        }
      }, 30_000, 'generate-metrics', 2)

      return Promise.all([checkMessages, checkTelemetry]).then(() => {
        assert.equal(appsecTelemetryReceived, true)

        return true
      })
    })
  })
})

'use strict'

const assert = require('node:assert/strict')

const path = require('node:path')
const Axios = require('axios')
const { describe, it, before, beforeEach, afterEach } = require('mocha')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')

describe('RASP - command_injection - integration', () => {
  let axios, cwd, appFile, agent, proc

  useSandbox(
    ['express'],
    false,
    [path.join(__dirname, 'resources')]
  )

  before(function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'resources', 'shi-app', 'index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_DEBUG: 'true',
        DD_APPSEC_ENABLED: 'true',
        DD_APPSEC_RASP_ENABLED: 'true',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        DD_APPSEC_RULES: path.join(cwd, 'resources', 'rasp_rules.json'),
      },
    })
    axios = Axios.create({ baseURL: proc.url })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  async function testRequestBlocked (url, ruleId = 3, variant = 'shell') {
    try {
      await axios.get(url)
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)

      let appsecTelemetryReceived = false

      const checkMessages = agent.assertMessageReceived(({ headers, payload }) => {
        assert.ok(Object.hasOwn(payload[0][0].meta, '_dd.appsec.json'))
        assert.match(payload[0][0].meta['_dd.appsec.json'], new RegExp(`"rasp-command_injection-rule-id-${ruleId}"`))
      }, 4_000)

      const checkTelemetry = agent.assertTelemetryReceived(({ headers, payload }) => {
        const namespace = payload.payload.namespace

        // Only check telemetry received in appsec namespace and ignore others
        if (namespace === 'appsec') {
          appsecTelemetryReceived = true
          const series = payload.payload.series
          const evalSerie = series.find(s => s.metric === 'rasp.rule.eval')
          const matchSerie = series.find(s => s.metric === 'rasp.rule.match')

          assert.ok(evalSerie)
          assert.ok(evalSerie.tags.includes('rule_type:command_injection'))
          assert.ok(evalSerie.tags.includes(`rule_variant:${variant}`))
          assert.strictEqual(evalSerie.type, 'count')

          assert.ok(matchSerie)
          assert.ok(matchSerie.tags.includes('rule_type:command_injection'))
          assert.ok(matchSerie.tags.includes(`rule_variant:${variant}`))
          assert.strictEqual(matchSerie.type, 'count')
        } else {
          assert.fail('namespace should be appsec')
        }
      }, 'generate-metrics', 4_000, 1, true)

      await Promise.all([checkMessages, checkTelemetry])

      assert.strictEqual(appsecTelemetryReceived, true)
      return
    }

    throw new Error('Request should be blocked')
  }

  describe('with shell', () => {
    it('should block using execFileSync and exception handled by express', async () => {
      await testRequestBlocked('/shi/execFileSync?dir=$(cat /etc/passwd 1>%262 ; echo .)')
    })

    it('should block using execFileSync and unhandled exception', async () => {
      await testRequestBlocked('/shi/execFileSync/out-of-express-scope?dir=$(cat /etc/passwd 1>%262 ; echo .)')
    })

    it('should block using execSync and exception handled by express', async () => {
      await testRequestBlocked('/shi/execSync?dir=$(cat /etc/passwd 1>%262 ; echo .)')
    })

    it('should block using execSync and unhandled exception', async () => {
      await testRequestBlocked('/shi/execSync/out-of-express-scope?dir=$(cat /etc/passwd 1>%262 ; echo .)')
    })
  })

  describe('without shell', () => {
    it('should block using execFileSync and exception handled by express', async () => {
      await testRequestBlocked('/cmdi/execFileSync?command=cat /etc/passwd 1>&2 ; echo .', 4, 'exec')
    })

    it('should block using execFileSync and unhandled exception', async () => {
      await testRequestBlocked(
        '/cmdi/execFileSync/out-of-express-scope?command=cat /etc/passwd 1>&2 ; echo .', 4, 'exec'
      )
    })
  })
})

'use strict'

const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')
const { linkedSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')

describe('IAST - code_injection - integration', () => {
  let axios, sandbox, cwd, agent, proc

  before(async function () {
    this.timeout(process.platform === 'win32' ? 300000 : 30000)

    sandbox = await linkedSandbox(
      ['express'],
      false,
      [path.join(__dirname, 'resources')]
    )

    cwd = sandbox.folder
  })

  after(async function () {
    this.timeout(60000)
    await sandbox?.remove()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  async function testVulnerabilityRepoting (url) {
    await axios.get(url)

    let iastTelemetryReceived = false
    const checkTelemetry = agent.assertTelemetryReceived(({ headers, payload }) => {
      const { namespace, series } = payload.payload

      if (namespace === 'iast') {
        iastTelemetryReceived = true

        const instrumentedSink = series.find(({ metric, tags, type }) => {
          return type === 'count' &&
            metric === 'instrumented.sink' &&
            tags[0] === 'vulnerability_type:code_injection'
        })
        assert.isNotNull(instrumentedSink)
      }
    }, 'generate-metrics', 30_000, 2)

    const checkMessages = agent.assertMessageReceived(({ headers, payload }) => {
      assert.strictEqual(payload[0][0].metrics['_dd.iast.enabled'], 1)
      assert.property(payload[0][0].meta, '_dd.iast.json')
      const vulnerabilitiesTrace = JSON.parse(payload[0][0].meta['_dd.iast.json'])
      assert.isNotNull(vulnerabilitiesTrace)
      const vulnerabilities = new Set()

      vulnerabilitiesTrace.vulnerabilities.forEach(v => {
        vulnerabilities.add(v.type)
      })

      assert.isTrue(vulnerabilities.has('CODE_INJECTION'))
    })

    await Promise.all([checkMessages, checkTelemetry])

    assert.equal(iastTelemetryReceived, true)
  }

  describe('SourceTextModule', () => {
    beforeEach(async () => {
      proc = await spawnProc(path.join(cwd, 'resources', 'vm.js'), {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_IAST_ENABLED: 'true',
          DD_IAST_REQUEST_SAMPLING: '100',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: 1
        },
        execArgv: ['--experimental-vm-modules']
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    it('should report Code injection vulnerability', async () => {
      await testVulnerabilityRepoting('/vm/SourceTextModule?script=export%20const%20result%20%3D%203%3B')
    })
  })

  describe('eval', () => {
    beforeEach(async () => {
      proc = await spawnProc(path.join(cwd, 'resources', 'eval.js'), {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_IAST_ENABLED: 'true',
          DD_IAST_REQUEST_SAMPLING: '100',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: 1
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    it('should report Code injection vulnerability', async () => {
      await testVulnerabilityRepoting('/eval?code=2%2B2')
    })
  })
})

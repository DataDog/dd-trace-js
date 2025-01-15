'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')
const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')

describe('IAST - code_injection - integration', () => {
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
    appFile = path.join(cwd, 'resources', 'vm.js')

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
        DD_TRACE_DEBUG: 'true',
        APP_PORT: appPort,
        DD_APPSEC_ENABLED: 'true',
        DD_IAST_ENABLED: 'true',
        DD_IAST_REQUEST_SAMPLING: '100'
      },
      execArgv: ['--experimental-vm-modules']
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  async function testVulnerabilityRepoting (url) {
    await axios.get(url)

    return agent.assertMessageReceived(({ headers, payload }) => {
      expect(payload[0][0].metrics['_dd.iast.enabled']).to.be.equal(1)
      expect(payload[0][0].meta).to.have.property('_dd.iast.json')
      const vulnerabilitiesTrace = JSON.parse(payload[0][0].meta['_dd.iast.json'])
      expect(vulnerabilitiesTrace).to.not.be.null
      const vulnerabilities = new Set()

      vulnerabilitiesTrace.vulnerabilities.forEach(v => {
        vulnerabilities.add(v.type)
      })

      expect(vulnerabilities.has('CODE_INJECTION')).to.be.true
    })
  }

  describe('SourceTextModule', () => {
    it('should report Code injection vulnerability', async () => {
      await testVulnerabilityRepoting('/vm/SourceTextModule?script=export%20const%20result%20%3D%203%3B')
    })
  })
})

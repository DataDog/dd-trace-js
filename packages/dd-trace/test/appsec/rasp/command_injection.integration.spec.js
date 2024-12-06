'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')
const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('RASP - command_injection - integration', () => {
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
    appFile = path.join(cwd, 'resources', 'shi-app', 'index.js')

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
        DD_APPSEC_RASP_ENABLED: 'true',
        DD_APPSEC_RULES: path.join(cwd, 'resources', 'rasp_rules.json')
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  async function testRequestBlocked (url) {
    try {
      await axios.get(url)
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)
      return await agent.assertMessageReceived(({ headers, payload }) => {
        assert.property(payload[0][0].meta, '_dd.appsec.json')
        assert.include(payload[0][0].meta['_dd.appsec.json'], '"rasp-command_injection-rule-id-3"')
      })
    }

    throw new Error('Request should be blocked')
  }

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

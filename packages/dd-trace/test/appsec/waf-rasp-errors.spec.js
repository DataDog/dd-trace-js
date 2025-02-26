'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../integration-tests/helpers')
const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe.only('WAF/RASP - timeout', () => {
  let axios, sandbox, cwd, appPort, appFile, agent, proc

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['express'],
      false,
      [
        path.join(__dirname, 'rasp', 'resources'),
        path.join(__dirname, '..', '..', 'src', 'appsec', 'recommended.json')
      ]
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
        APP_PORT: appPort,
        DD_APPSEC_ENABLED: 'true',
        DD_APPSEC_RASP_ENABLED: 'true',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        DD_APPSEC_WAF_TIMEOUT: 1,
        DD_APPSEC_RULES: path.join(cwd, 'recommended.json')
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('Should not block since waf will timeout', async () => {
    await axios.get('/shi/execFileSync?dir=$(cat /etc/passwd 1>%262 ; echo .)')
    await agent.assertMessageReceived(({ payload }) => {
      assert.property(payload[0][0].metrics, '_dd.appsec.rasp.timeout')
      assert.equal(payload[0][0].metrics['_dd.appsec.rasp.timeout'], 1)

      assert.property(payload[0][0].metrics, '_dd.appsec.waf.timeouts')
      assert(payload[0][0].metrics['_dd.appsec.waf.timeouts'] > 1)
    })
  })
})

describe.only('WAF/RASP - error', () => {
  let axios, sandbox, cwd, appPort, appFile, agent, proc

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['express'],
      false,
      [
        path.join(__dirname, 'rasp', 'resources'),
        path.join(__dirname, '..', '..', 'src', 'appsec', 'recommended.json')
      ]
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
        APP_PORT: appPort,
        DD_APPSEC_ENABLED: 'true',
        DD_APPSEC_RASP_ENABLED: 'true',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        DD_APPSEC_WAF_TIMEOUT: 0.1,
        DD_APPSEC_RULES: path.join(cwd, 'recommended.json')
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('Should not block since waf will return error', async () => {
    await axios.get('/shi/execFileSync?dir=$(cat /etc/passwd 1>%262 ; echo .)')
    await agent.assertMessageReceived(({ payload }) => {
      assert.property(payload[0][0].metrics, '_dd.appsec.rasp.error')
      assert.equal(payload[0][0].metrics['_dd.appsec.rasp.error'], -127)

      assert.property(payload[0][0].metrics, '_dd.appsec.waf.error')
      assert.equal(payload[0][0].metrics['_dd.appsec.waf.error'], -127)
    })
  })
})

'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')
const getPort = require('get-port')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

// These test are here and not in the integration tests
// because they require postgres instance
describe('RASP - sql_injection - integration', () => {
  let axios, sandbox, cwd, appPort, appFile, agent, proc, stdioHandler

  // function stdOutputHandler (data) {
  //   stdioHandler && stdioHandler(data)
  // }

  before(async () => {
    sandbox = await createSandbox(
      ['express', 'pg'],
      false,
      [path.join(__dirname, 'resources')])
    appPort = await getPort()
    cwd = sandbox.folder
    appFile = path.join(cwd, 'resources', 'postgress-app', 'index.js')
    axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        APP_PORT: appPort,
        DD_APPSEC_ENABLED: true,
        DD_APPSEC_RASP_ENABLED: true,
        DD_APPSEC_RULES: path.join(cwd, 'resources', 'rasp_rules.json')
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('should block using pg.Client and unhandled promise', async () => {
    try {
      await axios.get('/sqli/client/uncaught-promise?param=\' OR 1 = 1 --')
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)
      await agent.assertMessageReceived(({ headers, payload }) => {
        assert.property(payload[0][0].meta, '_dd.appsec.json')
        assert.include(payload[0][0].meta['_dd.appsec.json'], '"rasp-sqli-rule-id-2"')
      })
    }
  })

  it('should block using pg.Pool and unhandled promise', async () => {
    try {
      await axios.get('/sqli/pool/uncaught-promise?param=\' OR 1 = 1 --')
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)
      await agent.assertMessageReceived(({ headers, payload }) => {
        assert.property(payload[0][0].meta, '_dd.appsec.json')
        assert.include(payload[0][0].meta['_dd.appsec.json'], '"rasp-sqli-rule-id-2"')
      })
    }
  })
})

'use strict'

const { linkedSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('RASP - lfi - integration - sync', () => {
  let axios, sandbox, cwd, appFile, agent, proc

  before(async function () {
    this.timeout(60000)
    sandbox = await linkedSandbox(
      ['express', 'fs'],
      false,
      [path.join(__dirname, 'resources')])

    cwd = sandbox.folder
    appFile = path.join(cwd, 'resources', 'lfi-app', 'index.js')
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
        DD_APPSEC_ENABLED: true,
        DD_APPSEC_RASP_ENABLED: true,
        DD_APPSEC_RULES: path.join(cwd, 'resources', 'lfi_rasp_rules.json')
      }
    })
    axios = Axios.create({ baseURL: proc.url })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('should block a sync endpoint getting the error from apm:express:middleware:error', async () => {
    try {
      await axios.get('/lfi/sync?file=/etc/passwd')
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)
      return await agent.assertMessageReceived(({ headers, payload }) => {
        assert.property(payload[0][0].meta, '_dd.appsec.json')
        assert.include(payload[0][0].meta['_dd.appsec.json'], '"rasp-lfi-rule-id-1"')
      })
    }

    throw new Error('Request should be blocked')
  })
})

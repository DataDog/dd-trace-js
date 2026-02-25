'use strict'

const assert = require('node:assert/strict')

const path = require('path')
const Axios = require('axios')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')
describe('RASP - lfi - integration - sync', () => {
  let axios, cwd, appFile, agent, proc

  useSandbox(
    ['express', 'fs'],
    false,
    [path.join(__dirname, 'resources')])

  before(function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'resources', 'lfi-app', 'index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: 'true',
        DD_APPSEC_RASP_ENABLED: 'true',
        DD_APPSEC_RULES: path.join(cwd, 'resources', 'lfi_rasp_rules.json'),
      },
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
        assert.ok(Object.hasOwn(payload[0][0].meta, '_dd.appsec.json'))
        assert.match(payload[0][0].meta['_dd.appsec.json'], /"rasp-lfi-rule-id-1"/)
      })
    }

    throw new Error('Request should be blocked')
  })
})

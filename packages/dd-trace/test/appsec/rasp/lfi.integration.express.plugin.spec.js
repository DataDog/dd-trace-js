'use strict'

const assert = require('node:assert/strict')

const path = require('path')
const { inspect } = require('node:util')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc } = require('../../../../../integration-tests/helpers')
describe('RASP - lfi - integration - sync', () => {
  let cwd, appFile, agent, proc

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
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  /**
   * @param {string} url
   */
  async function request (url) {
    const response = await fetch(new URL(url, proc.url))
    await response.arrayBuffer()
    return response
  }

  it('should block a sync endpoint getting the error from apm:express:middleware:error', async () => {
    const response = await request('/lfi/sync?file=/etc/passwd')
    assert.strictEqual(response.status, 403)

    return agent.assertMessageReceived(({ headers, payload }) => {
      assert.ok(
        Object.hasOwn(payload[0][0].meta, '_dd.appsec.json'),
        `Available keys: ${inspect(Object.keys(payload[0][0].meta))}`
      )
      assert.match(payload[0][0].meta['_dd.appsec.json'], /"rasp-lfi-rule-id-1"/)
    })
  })
})

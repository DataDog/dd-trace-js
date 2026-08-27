'use strict'

const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const path = require('node:path')

const axios = require('axios')

const {
  FakeAgent,
  checkSpansForServiceName,
  sandboxCwd,
  spawnPluginIntegrationTestProc,
  stopProc,
  useSandbox,
} = require('../helpers')

describe('Turbopack integration', () => {
  useSandbox(['next', 'react', 'react-dom', 'ai', 'express'], false, [__dirname])

  let agent
  let proc

  before(async function () {
    this.timeout(300_000)
    execSync('npm exec -- next build', { cwd: appCwd(), stdio: 'inherit' })
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnPluginIntegrationTestProc(appCwd(), 'server.mjs', agent.port, {
      NODE_OPTIONS: '-r dd-trace/init',
    })
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('runs bundled CommonJS and ESM dependencies', async () => {
    const assertCjsTrace = agent.assertMessageReceived(({ payload }) => {
      assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
      assert.strictEqual(checkSpansForServiceName(payload, 'express.request'), true)
    }, 10_000, 1, true)

    const response = await axios.get(`${proc.url}/api/cjs`)
    assert.deepStrictEqual(response.data, { dependency: 'express' })
    await assertCjsTrace

    const assertEsmTrace = agent.assertMessageReceived(({ payload }) => {
      assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
    }, 10_000, 1, true)

    const esmResponse = await axios.get(`${proc.url}/api/esm`)
    assert.deepStrictEqual(esmResponse.data, { dependency: 'ai' })
    await assertEsmTrace
  })
})

function appCwd () {
  return path.join(sandboxCwd(), 'turbopack')
}

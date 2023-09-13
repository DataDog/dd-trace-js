'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    // next builds slower in the CI, match timeout with unit tests
    this.timeout(120 * 1000)
    sandbox = await createSandbox(['next', 'react', 'react-dom'],
      false, ['./packages/datadog-plugin-next/test/integration-test/*'], 'yarn exec next build')
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('next', () => {
    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, undefined, {
        // redefine this here as to also include the "--require" call
        NODE_OPTIONS: '--loader=dd-trace/loader-hook.mjs --require dd-trace/init'
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
      }, undefined, 3)
      // 3 traces will come in, and only one "passes" all 3 assertions
      // 1. something with 'node' as the service - never seen before, maybe related to the build/webpack process?
      // 2. when the server starts, a single 'dns.lookup' trace is generated - this is expected
      // 3. the actual trace for the request with the `next.request` span
    }).timeout(120 * 1000)
  })
})

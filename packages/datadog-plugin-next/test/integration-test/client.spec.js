'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

const hookFile = 'dd-trace/loader-hook.mjs'

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
        NODE_OPTIONS: `--loader=${hookFile} --require dd-trace/init`
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
      }, undefined, undefined, true)
    }).timeout(120 * 1000)
  })
})

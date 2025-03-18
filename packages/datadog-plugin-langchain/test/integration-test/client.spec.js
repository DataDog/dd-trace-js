'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { execSync } = require('child_process')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('langchain', ['@langchain/core'], '>=0.1', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([
        `@langchain/core@${version}`,
        `@langchain/openai@${version}`,
        'nock'
      ], false, [
        './packages/datadog-plugin-langchain/test/integration-test/*'
      ])
      // TODO - remove this once the branch is merged/published
      execSync('yarn link @datadog/wasm-js-rewriter', { cwd: sandbox.folder })
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'langchain.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, x => console.log(x.toString()), {
        NODE_OPTIONS: '--import dd-trace/initialize.mjs'
      })

      await res
    }).timeout(20000)
  })
})

'use strict'

const path = require('path')
const {
  FakeAgent,
  createSandbox,
  createCISandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // test against later versions because server.mjs uses newer package syntax
  withVersions('microgateway-core', 'microgateway-core', '>=3.0.0', version => {
    before(async function () {
      // Use regular sandbox (automatically optimized for CI)
      this.timeout(20000)
      sandbox = await createSandbox([`'microgateway-core@${version}'`, 'get-port'], false, [
        './packages/datadog-plugin-microgateway-core/test/integration-test/*'])
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

    it('is instrumented', async () => {
      // Use correct path for server.mjs based on sandbox type
      const isCI = process.env.CI || process.env.GITLAB_CI || process.env.GITHUB_ACTIONS
      const serverPath = isCI
        ? path.join(sandbox.folder, 'packages/datadog-plugin-microgateway-core/test/integration-test/server.mjs')
        : 'server.mjs'

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, serverPath, agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'microgateway.request'), true)
      })
    }).timeout(20000)
  })
})

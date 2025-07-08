'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc,
  assertObjectContains,
} = require('../../../../integration-tests/helpers')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('hono', 'hono', version => {
    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`'hono@${version}'`, '@hono/node-server@1.15.0'], false,
        ['./packages/datadog-plugin-hono/test/integration-test/*'])
    })

    after(async function () {
      this.timeout(50000)
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
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)
      proc.url += 'hello'

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assertObjectContains(headers, { host: `127.0.0.1:${agent.port}` })
        // TODO: Fix the resource! It should be 'GET /hello'
        // This seems to be a generic ESM issue, also e.g., on express.
        assertObjectContains(payload, [[{ name: 'hono.request', resource: 'GET' }]])
      })
    }).timeout(50000)
  })
})

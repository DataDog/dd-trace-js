'use strict'

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc,
  assertObjectContains,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm integration test', () => {
  let agent
  let proc

  withVersions('hono', 'hono', (range, _moduleName_, version) => {
    useSandbox([`'hono@${range}'`, '@hono/node-server@1.15.0'], false,
      ['./packages/datadog-plugin-hono/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port, { VERSION: version })
      proc.url += '/hello'

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assertObjectContains(headers, { host: `127.0.0.1:${agent.port}` })
        assertObjectContains(payload, [[{ name: 'hono.request', resource: 'GET /hello' }]])
      })
    }).timeout(50000)

    it('receives missing route trace', async () => {
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port, { VERSION: version })
      proc.url += '/missing'

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assertObjectContains(headers, { host: `127.0.0.1:${agent.port}` })
        assertObjectContains(payload, [[{ name: 'hono.request', resource: 'GET' }]])
      })
    }).timeout(50000)
  })
})

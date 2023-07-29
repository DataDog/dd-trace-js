'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  skipUnsupportedNodeVersions,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

let describe = skipUnsupportedNodeVersions()
describe = globalThis.fetch ? globalThis.describe : globalThis.describe.skip

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    this.timeout(20000)
    sandbox = await createSandbox(['express'], false, [`./integration-tests/plugin-helpers.mjs`,
      `./packages/datadog-plugin-fetch/test/integration-test/*`])
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

  context('fetch', () => {
    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        const isFetch = payload.some((span) => span.some((nestedSpan) => nestedSpan.meta.component === 'fetch'))
        assert.strictEqual(isFetch, true)
      })
    }).timeout(20000)
  })
})

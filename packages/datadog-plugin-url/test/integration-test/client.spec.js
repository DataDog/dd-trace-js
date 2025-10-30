
'use strict'

const {
  createSandbox, varySandbox, curl,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('ESM', () => {
  let sandbox, variants, proc, agent

  before(async function () {
    this.timeout(50000)
    sandbox = await createSandbox(['url', 'express'], false,
      ['./packages/datadog-plugin-url/test/integration-test/*'])
    variants = varySandbox(sandbox, 'server.mjs', 'node:url', 'URL')
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

  for (const variant of varySandbox.VARIANTS) {
    it(`is instrumented loaded with ${variant}`, async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)
      const response = await curl(proc)
      assert.equal(response.headers['x-counter'], '1')
    })
  }
})

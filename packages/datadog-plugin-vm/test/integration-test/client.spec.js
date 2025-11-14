'use strict'

const {
  useSandbox, sandboxCwd, varySandbox, curl,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const assert = require('node:assert/strict')

describe('ESM', () => {
  let variants, proc, agent

  useSandbox(['vm', 'express'], false,
    ['./packages/datadog-plugin-vm/test/integration-test/*'])

  before(function () {
    variants = varySandbox('server.mjs', 'node:vm', 'runInThisContext')
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
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
      const response = await curl(proc)
      assert.equal(response.headers['x-counter'], '1')
    })
  }
})

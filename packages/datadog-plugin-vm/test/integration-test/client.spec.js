'use strict'

const assert = require('node:assert/strict')
const {
  useSandbox,
  sandboxCwd,
  varySandbox,
  curl,
  FakeAgent,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')

describe('ESM', () => {
  let proc, agent

  useSandbox(['vm', 'express'], false,
    ['./packages/datadog-plugin-vm/test/integration-test/*'])

  const variants = varySandbox('server.mjs', {
    bindingName: 'vmLib',
    packageName: 'node:vm',
    defaultExport: true,
    namedExports: ['runInThisContext'],
    namedExportBinding: 'namespace',
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  for (const variant of Object.keys(variants)) {
    it(`is instrumented loaded with ${variant}`, async () => {
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
      const response = await curl(proc)
      assert.equal(response.headers['x-counter'], '1')
    })
  }
})

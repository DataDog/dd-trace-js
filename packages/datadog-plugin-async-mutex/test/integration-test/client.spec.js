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

  useSandbox(['async-mutex', 'express'], false,
    ['./packages/datadog-plugin-async-mutex/test/integration-test/*'])

  const variants = varySandbox('server.mjs', {
    bindingName: 'Mutex',
    packageName: 'async-mutex',
    defaultExport: false,
    namedExports: ['Mutex'],
    namedExportBinding: 'direct',
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
      assert.equal(response.headers['x-counter'], '2')
    })
  }
})

'use strict'

const assert = require('node:assert/strict')
const {
  useSandbox,
  sandboxCwd,
  varySandbox,
  FakeAgent,
  spawnPluginIntegrationTestProc,
  curl,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('node-serialize', 'node-serialize', version => {
  describe('ESM', () => {
    let proc, agent

    useSandbox([`'node-serialize@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-node-serialize/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'lib',
      packageName: 'node-serialize',
      defaultExport: true,
      namedExports: ['unserialize', 'serialize'],
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
})

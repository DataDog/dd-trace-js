'use strict'

const assert = require('node:assert/strict')
const {
  sandboxCwd,
  useSandbox,
  varySandbox,
  curl,
  FakeAgent,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('sequelize', 'sequelize', version => {
  describe('ESM', () => {
    let proc, agent

    useSandbox([`'sequelize@${version}'`, 'sqlite3', 'express'], false,
      ['./packages/datadog-plugin-sequelize/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'sequelizeLib',
      packageName: 'sequelize',
      defaultExport: true,
      namedExports: ['Sequelize'],
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

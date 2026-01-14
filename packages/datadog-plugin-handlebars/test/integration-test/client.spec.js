'use strict'

const assert = require('node:assert/strict')
const {
  sandboxCwd, useSandbox, varySandbox, curl,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('handlebars', 'handlebars', '>=4.0.0', version => {
  describe('ESM', () => {
    let variants, proc, agent

    useSandbox([`'handlebars@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-handlebars/test/integration-test/*'])

    before(function () {
      variants = varySandbox('server.mjs', 'Handlebars', undefined, 'handlebars')
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
})

'use strict'

const {
  sandboxCwd, useSandbox, varySandbox, curl,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const assert = require('node:assert/strict')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('pug', 'pug', version => {
  describe('ESM', () => {
    let variants, proc, agent

    useSandbox([`'pug@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-pug/test/integration-test/*'])

    before(function () {
      variants = varySandbox('server.mjs', 'pug')
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

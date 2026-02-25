'use strict'

const assert = require('node:assert/strict')
const {
  sandboxCwd, useSandbox, varySandbox, curl,
  FakeAgent, spawnPluginIntegrationTestProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('cookie', 'cookie', version => {
  describe('ESM', () => {
    let variants, proc, agent

    useSandbox([`'cookie@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-cookie/test/integration-test/*'])

    before(function () {
      variants = varySandbox('server.mjs', 'cookie')
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

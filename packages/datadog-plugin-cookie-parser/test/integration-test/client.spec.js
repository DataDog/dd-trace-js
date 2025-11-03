'use strict'

const {
  sandboxCwd, useSandbox, varySandbox, curl,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('cookie-parser', 'cookie-parser', version => {
  describe('ESM', () => {
    let variants, proc, agent

    useSandbox([`'cookie-parser@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-cookie-parser/test/integration-test/*'])

    before(function () {
      variants = varySandbox('server.mjs', 'cookieParser', undefined, 'cookie-parser')
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

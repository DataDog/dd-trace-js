'use strict'

const assert = require('node:assert/strict')
const {
  useSandbox, sandboxCwd, varySandbox,
  FakeAgent, spawnPluginIntegrationTestProc, curl
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('node-serialize', 'node-serialize', version => {
  describe('ESM', () => {
    let variants, proc, agent

    useSandbox([`'node-serialize@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-node-serialize/test/integration-test/*'])

    before(function () {
      variants = varySandbox('server.mjs', 'node-serialize', undefined, 'lib')
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

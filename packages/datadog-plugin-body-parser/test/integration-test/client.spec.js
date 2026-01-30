'use strict'

const assert = require('node:assert/strict')
const axios = require('axios')
const {
  sandboxCwd, useSandbox, varySandbox,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('body-parser', 'body-parser', version => {
  describe('ESM', () => {
    let variants, proc, agent

    useSandbox([`'body-parser@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-body-parser/test/integration-test/*'])

    before(function () {
      variants = varySandbox('server.mjs', 'bodyParser', undefined, 'body-parser')
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
        const response = await axios.post(`${proc.url}/`, { key: 'value' })
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})

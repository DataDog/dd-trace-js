'use strict'

const {
  sandboxCwd, useSandbox, varySandbox,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const assert = require('node:assert/strict')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const axios = require('axios')

withVersions('express-mongo-sanitize', 'express-mongo-sanitize', version => {
  describe('ESM', () => {
    let variants, proc, agent

    useSandbox([`'express-mongo-sanitize@${version}'`, 'express@<=4.0.0'], false,
      ['./packages/datadog-plugin-express-mongo-sanitize/test/integration-test/*'])

    before(function () {
      variants = varySandbox('server.mjs', 'expressMongoSanitize', undefined, 'express-mongo-sanitize')
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
        const proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
        const response = await axios.get(`${proc.url}/?param=paramvalue`)
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})

'use strict'

const assert = require('node:assert/strict')
const axios = require('axios')
const {
  sandboxCwd,
  useSandbox,
  varySandbox,
  FakeAgent,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('express-mongo-sanitize', 'express-mongo-sanitize', version => {
  describe('ESM', () => {
    let proc, agent

    useSandbox([`'express-mongo-sanitize@${version}'`, 'express@<=4.0.0'], false,
      ['./packages/datadog-plugin-express-mongo-sanitize/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'expressMongoSanitize',
      packageName: 'express-mongo-sanitize',
      defaultExport: true,
      namedExports: [],
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
        const response = await axios.get(`${proc.url}/?param=paramvalue`)
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})

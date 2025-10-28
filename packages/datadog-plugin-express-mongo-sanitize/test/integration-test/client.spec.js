'use strict'

const {
  createSandbox, varySandbox, curl,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const axios = require('axios')
withVersions('express-mongo-sanitize', 'express-mongo-sanitize', version => {
  describe('ESM', () => {
    let sandbox, variants, proc, agent

    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`'express-mongo-sanitize@${version}'`, 'express@<=4.0.0'], false,
        ['./packages/datadog-plugin-express-mongo-sanitize/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', 'expressMongoSanitize', undefined, 'express-mongo-sanitize')
    })

    after(async function () {
      this.timeout(50000)
      await sandbox.remove()
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
        const proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)
        const response = await axios.get(`${proc.url}/?param=paramvalue`)
        process._rawDebug('These are the response headers: ', response.headers)
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})

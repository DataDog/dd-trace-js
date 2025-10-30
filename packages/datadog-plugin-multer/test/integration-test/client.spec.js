'use strict'

const {
  createSandbox, varySandbox,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const axios = require('axios')

withVersions('multer', 'multer', version => {
  describe('ESM', () => {
    let sandbox, variants, proc, agent

    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`'multer@${version}'`, 'express'], false,
        ['./packages/datadog-plugin-multer/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', 'multer')
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
        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)
        const response = await axios.post(`${proc.url}/upload`, { key: 'value' })
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})

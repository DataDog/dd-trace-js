'use strict'

const assert = require('node:assert/strict')
const axios = require('axios')
const {
  useSandbox,
  sandboxCwd,
  varySandbox,
  FakeAgent,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('multer', 'multer', version => {
  describe('ESM', () => {
    let proc, agent

    useSandbox([`'multer@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-multer/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'multer',
      packageName: 'multer',
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
        const response = await axios.post(`${proc.url}/upload`, { key: 'value' })
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})

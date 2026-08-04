'use strict'

const assert = require('node:assert/strict')
const {
  sandboxCwd,
  useSandbox,
  varySandbox,
  curl,
  FakeAgent,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('passport-http', 'passport-http', version => {
  describe('ESM', () => {
    let proc, agent

    useSandbox(['passport', `passport-http@${version}`, 'express'], false,
      ['./packages/datadog-plugin-passport-http/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'passportHttp',
      packageName: 'passport-http',
      defaultExport: true,
      namedExports: ['BasicStrategy'],
      namedExportBinding: 'namespace',
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
        const response = await curl(proc)
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})

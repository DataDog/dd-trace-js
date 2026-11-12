'use strict'

const assert = require('node:assert/strict')
const {
  sandboxCwd,
  useSandbox,
  varySandbox,
  FakeAgent,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const httpRequest = require('../../../dd-trace/test/setup/helpers/http-client')

withVersions('body-parser', 'body-parser', version => {
  describe('ESM', () => {
    let proc, agent

    useSandbox([`'body-parser@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-body-parser/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'bodyParser',
      packageName: 'body-parser',
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
      it(`is instrumented ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
        const response = await httpRequest.post(`${proc.url}/`, { key: 'value' })
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})

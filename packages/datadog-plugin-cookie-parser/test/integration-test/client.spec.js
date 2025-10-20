'use strict'

const {
  createSandbox, varySandbox, curl,
  FakeAgent, spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('cookie-parser', 'cookie-parser', version => {
  describe('ESM', () => {
    let sandbox, variants, proc, agent

    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`'cookie-parser@${version}'`, 'express'], false,
        ['./packages/datadog-plugin-cookie-parser/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', 'cookie-parser', undefined, 'cookieParser')
    })

    after(async function () {
      this.timeout(50000)
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented loaded with ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)
        const response = await curl(proc)
        const counterValue = response.headers['x-counter']
        assert.equal(counterValue, '1')
      })
    }
  })
})

'use strict'

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { expect } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants

  withVersions('pino', 'pino', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'pino@${version}'`],
        false, ['./packages/datadog-plugin-pino/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', 'pino')
    })

    after(async () => {
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
        proc = await spawnPluginIntegrationTestProc(
          sandbox.folder,
          variants[variant],
          agent.port,
          (data) => {
            const jsonObject = JSON.parse(data.toString())
            expect(jsonObject).to.have.property('dd')
          }
        )
      }).timeout(20000)
    }
  })
})

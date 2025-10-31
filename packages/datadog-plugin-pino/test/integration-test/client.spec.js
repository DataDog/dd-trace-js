'use strict'

const {
  FakeAgent,
  spawnPluginIntegrationTestProc,
  sandboxCwd,
  useSandbox,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { expect } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('pino', 'pino', version => {
    useSandbox([`'pino@${version}'`],
      false, ['./packages/datadog-plugin-pino/test/integration-test/*'])

    before(async function () {
      variants = varySandbox('server.mjs', 'pino')
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
          sandboxCwd(),
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

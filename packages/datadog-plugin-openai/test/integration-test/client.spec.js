'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // limit v4 tests while the IITM issue is resolved or a workaround is introduced
  // this is only relevant for `openai` >=4.0 <=4.1
  // issue link: https://github.com/DataDog/import-in-the-middle/issues/60
  withVersions('openai', 'openai', '>=3 <4.0.0 || >4.1.0', (version) => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox(
        [
          `'openai@${version}'`,
          'nock',
          '@openai/agents',
          '@openai/agents-core',
        ],
        false,
        ['./packages/datadog-plugin-openai/test/integration-test/*']
      )
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

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(
          checkSpansForServiceName(payload, 'openai.request'),
          true
        )
      })

      proc = await spawnPluginIntegrationTestProc(
        sandbox.folder,
        'server.mjs',
        agent.port,
        null,
        {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
        }
      )

      await res
    }).timeout(20000)
  })
})

'use strict'

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
} = require('../../../../integration-tests/helpers')
const { withVersions, insertVersionDep } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')
const { join } = require('path')

describe('esm', () => {
  let agent
  let proc
  const env = {
    NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`
  }

  // limit v4 tests while the IITM issue is resolved or a workaround is introduced
  // this is only relevant for `openai` >=4.0 <=4.1
  // issue link: https://github.com/DataDog/import-in-the-middle/issues/60
  withVersions('openai', 'openai', '>=3 <4.0.0 || >4.1.0', (version) => {
    insertVersionDep(__dirname, 'openai', version)

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
        __dirname,
        'server.mjs',
        agent.port,
        null,
        env
      )

      await res
    }).timeout(20000)
  })
})

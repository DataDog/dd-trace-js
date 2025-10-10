'use strict'

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
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

  // excluding 8.16.0 for esm tests, because it is not working: https://github.com/elastic/elasticsearch-js/issues/2466
  withVersions('elasticsearch', ['@elastic/elasticsearch'], '<8.16.0 || >8.16.0', version => {
    insertVersionDep(__dirname, '@elastic/elasticsearch', version)

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of ['default', 'star', 'destructure']) {
      it(`is instrumented loaded with ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'elasticsearch.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(__dirname, `server-${variant}.mjs`, agent.port, undefined, env)

        await res
      }).timeout(20000)
    }
  })
})

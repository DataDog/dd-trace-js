'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants

  // excluding 8.16.0 for esm tests, because it is not working: https://github.com/elastic/elasticsearch-js/issues/2466
  withVersions('elasticsearch', ['@elastic/elasticsearch'], '<8.16.0 || >8.16.0', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'@elastic/elasticsearch@${version}'`], false, [
        './packages/datadog-plugin-elasticsearch/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', {
        default: `import elasticsearch from '@elastic/elasticsearch'`,
        star: `import * as elasticsearch from '@elastic/elasticsearch'`,
        destructure: `import { Client } from '@elastic/elasticsearch'; const elasticsearch = { Client }`
      })
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
    for (const variant of ['default', 'destructure', 'star']) {
      it(`is instrumented (${variant})`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'elasticsearch.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})

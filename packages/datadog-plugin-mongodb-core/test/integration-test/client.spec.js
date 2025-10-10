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

  // test against later versions because server.mjs uses newer package syntax
  withVersions('mongodb-core', 'mongodb', '>=4', version => {
    insertVersionDep(__dirname, 'mongodb', version)

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
          assert.strictEqual(checkSpansForServiceName(payload, 'mongodb.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(__dirname, `server-${variant}.mjs`, agent.port, undefined, env)

        await res
      }).timeout(30000)
    }
  })

  // test against later versions because server2.mjs uses newer package syntax
  withVersions('mongodb-core', 'mongodb-core', '>=3', version => {
    insertVersionDep(__dirname, 'mongodb-core', version)

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
          assert.strictEqual(checkSpansForServiceName(payload, 'mongodb.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(__dirname, `server2-${variant}.mjs`, agent.port, undefined, env)

        await res
      }).timeout(30000)
    }
  })
})

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
  withVersions('ioredis', 'ioredis', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'ioredis@${version}'`], false, [
        './packages/datadog-plugin-ioredis/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', {
        default: 'import Redis from \'ioredis\'',
        star: 'import * as modRedis from \'ioredis\'; const { default: Redis } = modRedis',
        destructure: 'import { default as Redis } from \'ioredis\''
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

    for (const variant of ['default', 'star', 'destructure']) {
      it(`is instrumented (${variant})`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'redis.command'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})

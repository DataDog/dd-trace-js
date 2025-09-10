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

  // test against later versions because server.mjs uses newer package syntax
  withVersions('amqplib', 'amqplib', '>=0.10.0', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'amqplib@${version}'`], false,
        ['./packages/datadog-plugin-amqplib/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', {
        default: `import amqplib from 'amqplib'`,
        star: `import * as amqplib from 'amqplib'`,
        destructure: `import { connect } from 'amqplib'; const amqplib = { connect }`
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
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'amqp.command'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})

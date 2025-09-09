'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants

  before(async function () {
    this.timeout(20000)
    sandbox = await createSandbox(['net'], false, [
      './packages/datadog-plugin-net/test/integration-test/*'])
    variants = varySandbox(sandbox, 'server.mjs', {
      default: `import net from 'net'`,
      star: `import * as net from 'net'`,
      destructure: `import { createConnection } from 'net'; const net = { createConnection }`
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

  context('net', () => {
    for (const variant of ['default', 'star', 'destructure']) {
      it(`is instrumented (${variant})`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'tcp.connect'), true)
          const metaContainsNet = payload.some((span) => span.some((nestedSpan) => nestedSpan.meta.component === 'net'))
          assert.strictEqual(metaContainsNet, true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})

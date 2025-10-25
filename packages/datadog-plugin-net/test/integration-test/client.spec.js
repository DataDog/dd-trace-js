'use strict'

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  sandboxCwd,
  useSandbox,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let variants

  useSandbox(['net'], false, [
    './packages/datadog-plugin-net/test/integration-test/*'])

  before(async function () {
    variants = varySandbox(sandbox, 'server.mjs', 'net', 'createConnection')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('net', () => {
    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented loaded with ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'tcp.connect'), true)
          const metaContainsNet = payload.some((span) => span.some((nestedSpan) => nestedSpan.meta.component === 'net'))
          assert.strictEqual(metaContainsNet, true)
        })

        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})

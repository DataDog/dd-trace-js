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
    sandbox = await createSandbox([], false, [
      './packages/datadog-plugin-dns/test/integration-test/*'])
    variants = varySandbox(sandbox, 'server.mjs', {
      default: `import dns from 'dns'`,
      star: `import * as dns from 'dns'`,
      destructure: `import { lookup } from 'dns'; const dns = { lookup }`
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

  context('dns', () => {
    for (const variant of ['default', 'star', 'destructure']) {
      it(`is instrumented (${variant})`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'dns.lookup'), true)
          assert.strictEqual(payload[0][0].resource, 'fakedomain.faketld')
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})

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
    this.timeout(60000)
    sandbox = await createSandbox(['axios'], false, [
      './packages/datadog-plugin-axios/test/integration-test/*'])
    variants = varySandbox(sandbox, 'server.mjs', 'axios')
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

  context('axios', () => {
    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented using ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'http.request'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})

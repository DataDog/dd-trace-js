'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  skipUnsupportedNodeVersions,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

const describe = skipUnsupportedNodeVersions()

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    this.timeout(50000)
    // TODO: Figure out why 10.x tests are failing.
    console.log(1)
    sandbox = await createSandbox(['next', 'react', 'react-dom', 'axios', 'get-port'], false,
      ['./packages/datadog-plugin-next/test/*'])
    console.log(33223)
    console.log(sandbox)
  })

  after(async () => {
    console.log(2)
    await sandbox.remove()
  })

  beforeEach(async () => {
    console.log(3)
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    console.log(5)
    proc && proc.kill()
    await agent.stop()
  })

  context('next', () => {
    it('is instrumented', async () => {
      console.log(4)
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'integration-test/server.mjs', agent.port)

      const payloads = []

      await curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        console.log(headers, payload, 4)
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        payloads.push(...payload)
        assert.strictEqual(checkSpansForServiceName(payloads, 'next.request'), true)
      }, 10000)

      await new Promise((resolve) => setTimeout(resolve, 5000))

      assert.strictEqual(checkSpansForServiceName(payloads, 'next.request'), true)
    }).timeout(50000)
  })
})

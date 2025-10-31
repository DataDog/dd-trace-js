'use strict'

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc

  withVersions('confluentinc-kafka-javascript', '@confluentinc/kafka-javascript', version => {
    useSandbox([`'@confluentinc/kafka-javascript@${version}'`], false, [
      './packages/datadog-plugin-confluentinc-kafka-javascript/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'kafka.produce'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port)

      await res
    }).timeout(5000)
  })
})

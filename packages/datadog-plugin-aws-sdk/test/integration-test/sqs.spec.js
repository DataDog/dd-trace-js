'use strict'

const assert = require('node:assert')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('recursion regression test', () => {
  let agent
  let proc

  withVersions('aws-sdk', ['@aws-sdk/smithy-client'], version => {
    useSandbox([`'@aws-sdk/client-sqs'@${version}'`], false, [
      './packages/datadog-plugin-aws-sdk/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('does not cause a recursion error when many commands are sent', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.equal(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload))
        assert.strictEqual(checkSpansForServiceName(payload, 'aws.request'), true)
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'recursion.mjs', agent.port, {
        AWS_SECRET_ACCESS_KEY: '0000000000/00000000000000000000000000000',
        AWS_ACCESS_KEY_ID: '00000000000000000000'
      }, ['--stack-size=128'])

      await res
    }).timeout(20000)
  })
})

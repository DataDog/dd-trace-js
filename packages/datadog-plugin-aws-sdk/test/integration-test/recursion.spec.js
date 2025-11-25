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
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'aws.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'recursion.mjs', agent.port, undefined,
        {
          AWS_SECRET_ACCESS_KEY: '0000000000/00000000000000000000000000000',
          AWS_ACCESS_KEY_ID: '00000000000000000000',
          execArgv: ['--stack-size=128']
        }
      )

      await res
    }).timeout(20000)
  })
})

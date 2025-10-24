'use strict'

const {
  FakeAgent,
  linkedSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('aws-sdk', ['aws-sdk'], version => {
    before(async function () {
      this.timeout(60000)
      sandbox = await linkedSandbox([`'aws-sdk@${version}'`], false, [
        './packages/datadog-plugin-aws-sdk/test/integration-test/*'])
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

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'aws.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, undefined,
        {
          AWS_SECRET_ACCESS_KEY: '0000000000/00000000000000000000000000000',
          AWS_ACCESS_KEY_ID: '00000000000000000000'
        }
      )

      await res
    }).timeout(20000)
  })
})

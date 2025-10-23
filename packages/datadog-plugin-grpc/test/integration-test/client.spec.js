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

  withVersions('grpc', '@grpc/grpc-js', version => {
    before(async function () {
      this.timeout(60000)
      sandbox = await linkedSandbox([`'@grpc/grpc-js@${version}'`, '@grpc/proto-loader'], false, [
        './packages/datadog-plugin-grpc/test/*'])
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
        assert.strictEqual(checkSpansForServiceName(payload, 'grpc.client'), true)
      })
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'integration-test/server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})

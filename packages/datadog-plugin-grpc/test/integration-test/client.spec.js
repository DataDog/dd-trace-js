'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { NODE_MAJOR } = require('../../../../version')

describe('esm', () => {
  let agent
  let proc

  withVersions('grpc', '@grpc/grpc-js', NODE_MAJOR >= 25 && '>=1.3.0', version => {
    useSandbox([`'@grpc/grpc-js@${version}'`, '@grpc/proto-loader'], false, [
      './packages/datadog-plugin-grpc/test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload))
        assert.strictEqual(checkSpansForServiceName(payload, 'grpc.client'), true)
      })
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'integration-test/server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})

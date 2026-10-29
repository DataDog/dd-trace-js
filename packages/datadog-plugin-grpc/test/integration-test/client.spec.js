'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProc,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { NODE_MAJOR } = require('../../../../version')

describe('esm', () => {
  let agent
  let proc

  withVersions('grpc', '@grpc/grpc-js', NODE_MAJOR >= 25 ? '>=1.3.0' : '*', version => {
    useSandbox([`'@grpc/grpc-js@${version}'`, '@grpc/proto-loader'], false, [
      './packages/datadog-plugin-grpc/test/integration-test/server.mjs',
      './packages/datadog-plugin-grpc/test/test.proto'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'grpc',
      packageName: '@grpc/grpc-js',
      defaultExport: true,
      namedExports: ['loadPackageDefinition', 'Server', 'ServerCredentials', 'credentials', 'Client'],
      namedExportBinding: 'namespace',
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          const clientSpans = payload.flat().filter(s => s.name === 'grpc.client')
          assert.strictEqual(clientSpans.length, 1,
            `expected 1 grpc.client span, got ${clientSpans.length} — possible double-patch`)
        })
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})

'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  checkSpansForServiceName,
  sandboxCwd,
  spawnPluginIntegrationTestProcAndExpectExit,
  stopProc,
  useSandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('runtime loading', () => {
  let agent
  let proc

  withVersions('dataloader', 'dataloader', version => {
    useSandbox([`'dataloader@${version}'`], false, [
      './packages/datadog-plugin-dataloader/test/integration-test/*',
    ])

    const variants = { default: 'server.mjs' }

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it('is instrumented from an ESM module', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'dataloader.load'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port,
          { NODE_OPTIONS: '--import dd-trace/initialize.mjs' }
        )

        await res
      }).timeout(20000)
    }

    it('is instrumented with a CommonJS require', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
        assert.strictEqual(checkSpansForServiceName(payload, 'dataloader.load'), true)
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.cjs', agent.port)

      await res
    }).timeout(20000)
  })
})

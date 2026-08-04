'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  checkSpansForServiceName,
  FakeAgent,
  sandboxCwd,
  spawnPluginIntegrationTestProcAndExpectExit,
  stopProc,
  useSandbox,
  varySandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

  withVersions('postgres', 'postgres', version => {
    useSandbox([`'postgres@${version}'`], false, [
      './packages/datadog-plugin-postgres/test/integration-test/*',
    ])

    const variants = varySandbox('server.mjs', {
      bindingName: 'postgres',
      defaultExport: true,
      namedExports: [],
      packageName: 'postgres',
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented loaded with ${variant}`, async () => {
        const traceReceived = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'postgres.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await traceReceived
      }).timeout(20000)
    }

    it('injects DBM propagation through the ESM connection path', async () => {
      const traceReceived = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
        const span = payload.flat().find(span => span.meta.component === 'postgres')
        assert.ok(span)
        assert.strictEqual(span.service, 'serviced')
        assert.strictEqual(span.resource, 'SELECT current_query() AS query')
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'dbm-server.mjs', agent.port)

      await traceReceived
    }).timeout(20000)
  })
})

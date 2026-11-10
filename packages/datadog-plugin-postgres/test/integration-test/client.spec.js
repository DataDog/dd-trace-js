'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const semver = require('semver')

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

  withVersions('postgres', 'postgres', '>=3', (version, moduleName, resolvedVersion) => {
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
          const querySpan = payload.flat().find(span => span.meta?.component === 'postgres')
          assert.ok(querySpan.metrics['db.pool.wait_time_ms'] > 0)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port,
          { DD_DBM_PROPAGATION_MODE: 'service' }
        )

        await traceReceived
      }).timeout(20000)
    }

    it('handles the Query class loading before tracing', async () => {
      const native = semver.gte(resolvedVersion, '4.0.0')
      const messages = []
      const onMessage = message => messages.push(message)
      agent.on('message', onMessage)

      try {
        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          native ? 'native.mjs' : 'partial-rewrite.cjs',
          agent.port,
          {
            DD_DBM_PROPAGATION_MODE: 'service',
            NODE_OPTIONS: native
              ? '--loader=dd-trace/loader-hook.mjs --import=./preload-query.mjs'
              : '--require=./preload-query.cjs',
          }
        )
      } finally {
        agent.removeListener('message', onMessage)
      }

      const spans = messages.flatMap(({ payload }) => Array.isArray(payload) ? payload.flat() : [])
      assert.strictEqual(spans.some(span => span.meta?.component === 'postgres'), native)
    }).timeout(20000)
  })
})

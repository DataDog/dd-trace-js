'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const semver = require('semver')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

// Connect and query can take 15s and 10s respectively; reserve another 5s for close, flush, and exit.
const processTimeoutMs = 30_000
const messageTimeoutMs = processTimeoutMs + 10_000

describe('esm', () => {
  let agent
  let proc

  withVersions('oracledb', 'oracledb', version => {
    useSandbox([`'oracledb@${version}'`], false, [
      './packages/datadog-plugin-oracledb/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'oracledb',
      packageName: 'oracledb',
      defaultExport: true,
      namedExports: [],
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    const modes = semver.intersects(version, '>=6.0.0') ? ['default', 'thick'] : ['default']

    for (const variant of Object.keys(variants)) {
      for (const mode of modes) {
        const suffix = mode === 'thick' ? ' in Thick mode' : ''

        it(`is instrumented ${variant}${suffix}`, async () => {
          const messageReceived = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
            assert.strictEqual(checkSpansForServiceName(payload, 'oracle.query'), true)
            assert.strictEqual(checkSpansForServiceName(payload, 'oracle.pool.acquire'), true)

            if (mode === 'thick') {
              const acquireSpans = payload.flat().filter(span => span.name === 'oracle.pool.acquire')
              assert.strictEqual(acquireSpans.length, 2)
              for (const span of acquireSpans) {
                assert.strictEqual(span.meta['db.user'], 'test')
              }
            }
          }, messageTimeoutMs)

          const completed = spawnPluginIntegrationTestProcAndExpectExit(
            sandboxCwd(),
            variants[variant],
            agent.port,
            mode === 'thick' ? { ORACLEDB_THICK: 'true' } : undefined,
            undefined,
            undefined,
            processTimeoutMs
          )
          proc = completed.proc

          await Promise.all([
            completed,
            messageReceived,
          ])
        }).timeout(messageTimeoutMs + 5_000)
      }
    }
  })
})

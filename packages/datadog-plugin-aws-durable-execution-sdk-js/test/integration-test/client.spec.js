'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { NODE_MAJOR } = require('../../../../version')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

// @aws/durable-execution-sdk-js (>=1.1.0, our minimum supported version) requires Node.js >=22.
if (NODE_MAJOR < 22) return

const COMPONENT = 'aws-durable-execution-sdk-js'

describe('esm', () => {
  let agent
  let proc
  let variants

  // Ride the same SDK version matrix as the unit suite (createIntegrationTestSuite). The local
  // test runner is a separate companion package; like the unit suite (versions/package.json),
  // it stays pinned across every SDK version under test.
  withVersions('aws-durable-execution-sdk-js', '@aws/durable-execution-sdk-js', version => {
    useSandbox([
      `@aws/durable-execution-sdk-js@${version}`,
      '@aws/durable-execution-sdk-js-testing@1.1.1',
    ], false, [
      './packages/datadog-plugin-aws-durable-execution-sdk-js/test/integration-test/*',
    ])

    before(async function () {
      variants = varySandbox('server.mjs', 'withDurableExecution', undefined, '@aws/durable-execution-sdk-js', true)
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    // The SDK is instrumented via Orchestrion source rewriting, so the import shape on the
    // consumer side should not matter. Exercise both to guard the ESM rewrite path.
    for (const variant of ['star', 'destructure']) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)

          const durableSpans = new Set()
          for (const trace of payload) {
            for (const span of trace) {
              if (span.meta?.component === COMPONENT) {
                durableSpans.add(span.name)
              }
            }
          }
          assert.ok(durableSpans.has('aws.durable.execute'),
            `expected an aws.durable.execute span, saw: ${inspect([...durableSpans])}`)
          assert.ok(durableSpans.has('aws.durable.step'),
            `expected an aws.durable.step span, saw: ${inspect([...durableSpans])}`)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
        })

        await res
      }).timeout(20000)
    }
  })
})

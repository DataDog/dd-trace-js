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

    it('does not trace when the Query class loads before tracing', async () => {
      const messages = []
      const onMessage = message => messages.push(message)
      agent.on('message', onMessage)

      try {
        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          'partial-rewrite.cjs',
          agent.port,
          { NODE_OPTIONS: '--require=./preload-query.cjs' }
        )
      } finally {
        agent.removeListener('message', onMessage)
      }

      const spans = messages.flatMap(({ payload }) => Array.isArray(payload) ? payload.flat() : [])
      assert.strictEqual(spans.some(span => span.meta?.component === 'postgres'), false)
    }).timeout(20000)
  })
})

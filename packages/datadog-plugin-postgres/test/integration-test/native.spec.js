'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  spawnPluginIntegrationTestProcAndExpectExit,
  stopProc,
  useSandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('postgres native diagnostics', () => {
  withVersions('postgres', 'postgres', '>=4', version => {
    useSandbox([`'postgres@${version}'`], false, [
      './packages/datadog-plugin-postgres/test/integration-test/*',
    ])

    let agent
    let proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const mode of ['disabled', 'service', 'full', 'dynamic_service']) {
      it(`preserves results and traces queries with DBM ${mode}`, async () => {
        const messages = []
        agent.on('message', message => messages.push(message))

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(), 'native.mjs', agent.port, { DD_DBM_PROPAGATION_MODE: mode }
        )

        const spans = messages.flatMap(({ payload }) => Array.isArray(payload) ? payload.flat() : [])
          .filter(span => span.meta?.component === 'postgres')
        assert.strictEqual(spans.filter(span => span.resource === 'SELECT $1::int AS value').length, 1)
        const wireSpans = spans.filter(span => span.resource === 'SELECT current_query() AS query')
        assert.strictEqual(wireSpans.length, 2)
        for (const span of wireSpans) {
          assert.strictEqual(span.meta['db.name'], 'postgres')
          assert.strictEqual(span.meta['db.user'], 'postgres')
          assert.strictEqual(span.meta['out.host'], '127.0.0.1')
          assert.strictEqual(span.metrics['network.destination.port'], 5432)
          assert.ok(span.metrics['db.pool.wait_time_ms'] >= 0)
        }
        assert.strictEqual(spans.filter(span => span.resource === 'INVALID NATIVE SQL' && span.error === 1).length, 1)
      }).timeout(20000)
    }
  })
})

'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('trpc ESM', () => {
  let agent

  withVersions('trpc', '@trpc/server', version => {
    useSandbox([`'@trpc/server@${version}'`, "'express@^5'"], false, [
      './packages/datadog-plugin-trpc/test/integration-test/server.mjs',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await agent.stop()
    })

    it('preserves public calls and exports their procedure spans', async () => {
      const traces = []
      agent.on('message', ({ payload }) => traces.push(...payload))
      const httpTrace = agent.assertMessageReceived(({ payload }) => {
        assert.ok(payload.flat().some(span => span.name === 'express.request'))
      })

      await spawnPluginIntegrationTestProcAndExpectExit(
        sandboxCwd(),
        'server.mjs',
        agent.port,
        { TRPC_TRACE_MODE: 'traced' }
      )
      await httpTrace

      const procedureSpans = traces.flat().filter(span => span.name === 'trpc.procedure')
      assert.deepStrictEqual(procedureSpans.map(span => span.resource).sort(), [
        'mutation setValue', 'query getValue', 'query getValue',
      ])
      const requestTrace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      const requestSpan = requestTrace.find(span => span.name === 'express.request')
      assert.strictEqual(requestSpan.resource, 'GET /trpc/getValue')
      assert.strictEqual(requestTrace.filter(span => span.name === 'trpc.procedure').length, 1)
      const middlewareSpan = requestTrace.find(span => span.name === 'router.middleware')
      assert.ok(middlewareSpan)
      assert.strictEqual(String(middlewareSpan.parent_id), String(requestSpan.span_id))
      assert.strictEqual(String(requestTrace.find(span => span.name === 'trpc.procedure').parent_id),
        String(middlewareSpan.span_id))
    }).timeout(20000)
  })
})

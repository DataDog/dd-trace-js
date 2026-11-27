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
  const samplingEnv = {
    DD_TRACE_OTEL_SEMANTICS_ENABLED: 'false',
    // The HTTP server owns the sampling decision for requests from the fixture's client.
    DD_TRACE_PROPAGATION_STYLE_EXTRACT: 'none',
    OTEL_TRACES_EXPORTER: undefined,
  }
  let agent

  withVersions('trpc', '@trpc/server', version => {
    useSandbox([`'@trpc/server@${version}'`, "'express@^5'"], false, [
      './packages/datadog-plugin-trpc/test/integration-test/server.mjs',
      './packages/datadog-plugin-trpc/test/integration-test/sampling.mjs',
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
        agent.port
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

    it('samples only the procedure selected by the native HTTP adapter', async () => {
      const procedure = version.startsWith('10') ? 'setValue' : 'getValue'
      const route = '/tenant/:tenantId/trpc/' + procedure
      const env = {
        ...samplingEnv,
        DD_TRACE_SAMPLE_RATE: '0',
        DD_TRACE_SAMPLING_RULES: JSON.stringify([
          { resource: 'GET ' + route, sample_rate: 1 },
          { resource: 'POST ' + route, sample_rate: 1 },
        ]),
      }
      await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'sampling.mjs', agent.port, env)
    }).timeout(20000)

    it('keeps the outer HTTP resource after a nested Fetch batch in the procedure', async () => {
      let resource
      const trace = agent.assertMessageReceived(({ payload }) => {
        const span = payload.flat().find(span => span.name === 'express.request')
        assert.ok(span)
        resource = span.resource
      })
      const env = {
        ...samplingEnv,
        DD_TRACE_SAMPLE_RATE: '1',
        DD_TRACE_SAMPLING_RULES: '[]',
        TRPC_TEST_NESTED_FETCH_BATCH: 'true',
      }
      await Promise.all([
        trace,
        spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'sampling.mjs', agent.port, env),
      ])
      assert.strictEqual(resource, 'GET /tenant/:tenantId/trpc/fetchBatch')
    }).timeout(20000)
  })
})

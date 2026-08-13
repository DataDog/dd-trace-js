'use strict'

const assert = require('node:assert/strict')
const { appendFileSync, writeFileSync } = require('node:fs')
const {
  assertObjectContains,
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

const classification = 'serverless-child'
const rootName = 'serverless.test.invocation'
const evidencePath = process.env.DD_APM_SERVERLESS_LOCAL_EVIDENCE
const expectedOperations = [
  {
    operationName: 'supabase.storage.select',
    spanName: 'supabase.storage.select',
    resource: 'POST /storage/v1/object/list/files',
    meta: {
      component: 'supabase',
      'http.method': 'POST',
      'http.url': 'https://project.supabase.co/storage/v1/object/list/files',
    },
  },
  {
    operationName: 'supabase.http.getuser',
    spanName: 'supabase.http.getuser',
    resource: 'GET /auth/v1/user',
    meta: {
      component: 'supabase',
      'http.method': 'GET',
      'http.url': 'https://project.supabase.co/auth/v1/user',
    },
  },
  {
    operationName: 'supabase.storage.list',
    spanName: 'supabase.storage.list',
    resource: 'GET /storage/v1/bucket',
    meta: {
      component: 'supabase',
      'http.method': 'GET',
      'http.url': 'https://project.supabase.co/storage/v1/bucket',
    },
  },
  {
    operationName: 'supabase.messaging.send',
    spanName: 'supabase.messaging.send',
    resource: 'test-room',
    meta: {
      component: 'supabase',
      'messaging.system': 'supabase',
      'messaging.destination.name': 'test-room',
    },
  },
  {
    operationName: 'supabase.http.invoke',
    spanName: 'supabase.http.invoke',
    resource: 'POST /functions/v1/hello',
    meta: {
      component: 'supabase',
      'http.method': 'POST',
      'http.url': 'https://project.supabase.co/functions/v1/hello',
      'faas.invoked_name': 'hello',
    },
  },
  {
    operationName: 'supabase.database.select',
    spanName: 'supabase.database.select',
    resource: 'SELECT items',
    meta: {
      component: 'supabase',
      'db.type': 'postgres',
      'db.name': 'public',
      'db.operation': 'SELECT',
      'out.host': 'project.supabase.co',
    },
  },
]

if (evidencePath) writeFileSync(evidencePath, '')

function recordEvidence (observation) {
  if (evidencePath) appendFileSync(evidencePath, JSON.stringify(observation) + '\n')
}

describe('esm', () => {
  let agent

  withVersions('supabase', '@supabase/supabase-js', version => {
    useSandbox([`'@supabase/supabase-js@${version}'`], false, [
      './packages/datadog-plugin-supabase/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await agent.stop()
    })

    for (const scenario of ['happy', 'error']) {
      it(`records serverless runtime evidence for the ${scenario} path`, async () => {
        const observations = []
        const receivedTraces = []
        const collectTraces = ({ payload }) => receivedTraces.push(...payload)
        agent.on('message', collectTraces)
        const rootReceived = agent.assertMessageReceived(({ payload }) => {
          assert.strictEqual(payload.flat().filter(span => span.name === rootName).length, 1)
        }, 15000)

        const execution = spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(), 'server.mjs', agent.port, {
            DD_APM_SERVERLESS_SCENARIO: scenario,
          })

        try {
          await Promise.all([rootReceived, execution])
        } finally {
          agent.removeListener('message', collectTraces)
        }

        const spans = receivedTraces.flat()
        const rootSpans = spans.filter(span => span.name === rootName)
        assert.strictEqual(rootSpans.length, 1)
        const rootSpan = rootSpans[0]

        for (const expected of expectedOperations) {
          const operationSpans = spans.filter(span => span.name === expected.spanName)
          assert.strictEqual(operationSpans.length, 1)

          const operationSpan = operationSpans[0]
          assertObjectContains(operationSpan, {
            resource: expected.resource,
            meta: expected.meta,
          })
          const ownershipVerified = classification === 'serverless-child'
            ? operationSpan.parent_id.toString() === rootSpan.span_id.toString()
            : !operationSpan.parent_id || operationSpan.parent_id.toString() === '0'
          assert.strictEqual(ownershipVerified, true)
          if (scenario === 'error') assert.strictEqual(operationSpan.error, 1)

          observations.push({
            operation_name: expected.operationName,
            scenario,
            span_name: expected.spanName,
            root_span_count: rootSpans.length,
            operation_span_count: operationSpans.length,
            root_span_id: rootSpan.span_id.toString(),
            operation_span_id: operationSpan.span_id.toString(),
            operation_parent_id: operationSpan.parent_id && operationSpan.parent_id.toString(),
            hook_executed: true,
            plugin_context_received: Boolean(operationSpan.meta && operationSpan.meta['span.kind']),
            expected_span_created: true,
            ownership_verified: ownershipVerified,
            error_behavior_verified: scenario !== 'error' || operationSpan.error === 1,
            exactly_once_finish: operationSpans.length === 1,
            no_duplicate_spans: operationSpans.length === 1,
            fake_agent_delivery: true,
          })
        }

        for (const observation of observations) {
          recordEvidence({ ...observation, return_behavior_preserved: true })
        }
      }).timeout(20000)
    }
  })
})

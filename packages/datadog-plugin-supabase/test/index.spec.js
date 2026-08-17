'use strict'

const assert = require('node:assert/strict')
const { appendFileSync, writeFileSync } = require('node:fs')

const { ANY_STRING, assertObjectContains } = require('../../../integration-tests/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const serverlessClassification = 'serverless-child'
const serverlessRootName = 'serverless.test.invocation'
const serverlessEvidencePath = process.env.DD_APM_SERVERLESS_LOCAL_EVIDENCE

if (serverlessEvidencePath) writeFileSync(serverlessEvidencePath, '')

function recordServerlessEvidence (observation) {
  if (serverlessEvidencePath) {
    appendFileSync(serverlessEvidencePath, JSON.stringify(observation) + '\n')
  }
}

async function runServerlessContract ({
  agent,
  tracer,
  operationName,
  scenario,
  expectedSpan,
  run,
  shouldReject = false,
}) {
  let returned
  let thrown
  const spanName = expectedSpan.name
  const rootTraceOptions = serverlessClassification === 'serverless-child'
    ? { spanResourceMatch: new RegExp(serverlessRootName.replaceAll('.', '\\.')) }
    : undefined
  const operationTraceOptions = expectedSpan.resource
    ? { spanResourceMatch: new RegExp(expectedSpan.resource) }
    : undefined
  const receivedTraces = []
  const collectTraces = traces => receivedTraces.push(...traces)
  agent.subscribe(collectTraces)

  const rootTraceAssertion = agent.assertSomeTraces((traces) => {
    assert.ok(traces.flat().some(span => span.name === serverlessRootName))
  }, rootTraceOptions)
  const operationTraceAssertion = agent.assertSomeTraces((traces) => {
    assert.ok(traces.flat().some(span => span.name === spanName))
  }, operationTraceOptions)

  try {
    try {
      if (serverlessClassification === 'serverless-child') {
        returned = await tracer.trace(serverlessRootName, async () => run())
      } else {
        returned = await run()
      }
    } catch (error) {
      thrown = error
    }

    await Promise.all([rootTraceAssertion, operationTraceAssertion])
  } finally {
    agent.unsubscribe(collectTraces)
  }

  const spans = receivedTraces.flat()
  const operationSpans = spans.filter(span => span.name === spanName)
  const supabaseSpans = spans.filter(span => span.meta?.component === 'supabase')
  const rootSpans = serverlessClassification === 'serverless-child'
    ? spans.filter(span => span.name === serverlessRootName)
    : operationSpans

  assert.strictEqual(rootSpans.length, 1, 'expected exactly one serverless root span')
  assert.strictEqual(operationSpans.length, 1, 'expected exactly one operation span')
  assert.strictEqual(supabaseSpans.length, 1, 'expected exactly one Supabase span')

  const rootSpan = rootSpans[0]
  const operationSpan = operationSpans[0]
  const ownershipVerified = serverlessClassification === 'serverless-child'
    ? operationSpan.parent_id.toString() === rootSpan.span_id.toString()
    : !operationSpan.parent_id || operationSpan.parent_id.toString() === '0'
  const callerObservedError = Boolean(
    thrown || returned?.error || returned === 'error' || returned === 'timed out'
  )
  const returnBehaviorPreserved = shouldReject ? Boolean(thrown) : !thrown

  assert.strictEqual(ownershipVerified, true, 'span ownership must match the serverless route')
  assert.strictEqual(returnBehaviorPreserved, true, 'instrumentation must preserve return behavior')
  assertObjectContains(operationSpan, expectedSpan)

  recordServerlessEvidence({
    operation_name: operationName,
    scenario,
    span_name: spanName,
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
    return_behavior_preserved: returnBehaviorPreserved,
    fake_agent_delivery: true,
  })

  if (scenario === 'error') {
    assert.strictEqual(callerObservedError, true, 'error must remain observable to the caller')
  }
  return returned
}

const testSetup = new TestSetup()

createIntegrationTestSuite('supabase', '@supabase/supabase-js', {
  category: 'cloud-provider',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('storage file requests - supabase.storage.request', () => {
    it('should satisfy the serverless ownership contract (happy path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.storage.request',
        scenario: 'happy',
        expectedSpan:
        {
          name: 'supabase.storage.request',
          service: 'test',
          resource: 'POST object/list',
          type: 'storage',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'POST',
            'http.url': 'https://project.supabase.co/storage/v1/object/list/files',
          },
          metrics: {},
        },
        run: () => testSetup.storageFileList(),
      })
    })

    it('should satisfy the serverless ownership contract (error path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.storage.request',
        scenario: 'error',
        expectedSpan:
        {
          name: 'supabase.storage.request',
          service: 'test',
          resource: 'POST object/list',
          type: 'storage',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'POST',
            'http.url': 'https://project.supabase.co/storage/v1/object/list/files',
            'http.status_code': '500',
            'error.type': 'StorageApiError',
            'error.message': 'Storage unavailable',
            'error.stack': ANY_STRING,
          },
          metrics: {},
          error: 1,
        },
        run: () => testSetup.storageFileListError(),
      })
    })

    for (const path of ['avatars/user-1.png', 'documents/report.pdf']) {
      it(`normalizes the object path for ${path}`, async () => {
        return runServerlessContract({
          agent,
          tracer: meta.tracer,
          operationName: 'supabase.storage.request',
          scenario: 'happy',
          expectedSpan: {
            name: 'supabase.storage.request',
            service: 'test',
            resource: 'GET object/info',
            type: 'storage',
            meta: {
              component: 'supabase',
              'span.kind': 'client',
              'http.method': 'GET',
              'http.url': `https://project.supabase.co/storage/v1/object/info/files/${path}`,
            },
            metrics: {},
          },
          run: () => testSetup.storageFileInfo(path),
        })
      })
    }
  })

  describe('GoTrueClient.getUser() - supabase.http.getuser', () => {
    it('should satisfy the serverless ownership contract (happy path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.http.getuser',
        scenario: 'happy',
        expectedSpan:
        {
          name: 'supabase.http.getuser',
          service: 'test',
          resource: 'GET /auth/v1/user',
          type: 'http',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'GET',
            'http.url': 'https://project.supabase.co/auth/v1/user',
            'http.status_code': '200',
          },
          metrics: {},
        },
        run: () => testSetup.goTrueClientGetUser(),
      })
    })

    it('should satisfy the serverless ownership contract (error path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.http.getuser',
        scenario: 'error',
        expectedSpan:
        {
          name: 'supabase.http.getuser',
          service: 'test',
          resource: 'GET /auth/v1/user',
          type: 'http',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'GET',
            'http.url': 'https://project.supabase.co/auth/v1/user',
            'http.status_code': '401',
            'error.type': 'AuthApiError',
            'error.message': 'Invalid token',
            'error.stack': ANY_STRING,
          },
          metrics: {},
          error: 1,
        },
        run: () => testSetup.goTrueClientGetUserError(),
      })
    })
  })

  describe('StorageBucketApi.listBuckets() - supabase.storage.request', () => {
    it('should satisfy the serverless ownership contract (happy path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.storage.request',
        scenario: 'happy',
        expectedSpan:
        {
          name: 'supabase.storage.request',
          service: 'test',
          resource: 'GET bucket',
          type: 'storage',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'GET',
            'http.url': 'https://project.supabase.co/storage/v1/bucket',
          },
          metrics: {},
        },
        run: () => testSetup.storageBucketApiListBuckets(),
      })
    })

    it('should satisfy the serverless ownership contract (error path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.storage.request',
        scenario: 'error',
        expectedSpan:
        {
          name: 'supabase.storage.request',
          service: 'test',
          resource: 'GET bucket',
          type: 'storage',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'GET',
            'http.url': 'https://project.supabase.co/storage/v1/bucket',
            'http.status_code': '500',
            'error.type': 'StorageApiError',
            'error.message': 'Storage unavailable',
            'error.stack': ANY_STRING,
          },
          metrics: {},
          error: 1,
        },
        run: () => testSetup.storageBucketApiListBucketsError(),
      })
    })
  })

  describe('RealtimeChannel.send() - supabase.messaging.send', () => {
    it('should satisfy the serverless ownership contract (happy path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.messaging.send',
        scenario: 'happy',
        expectedSpan:
        {
          name: 'supabase.messaging.send',
          service: 'test',
          resource: 'test-room',
          type: 'messaging',
          meta: {
            component: 'supabase',
            'span.kind': 'producer',
            'messaging.system': 'supabase',
            'messaging.destination.name': 'test-room',
            'messaging.destination.kind': 'topic',
            'messaging.operation': 'send',
          },
          metrics: {},
        },
        run: () => testSetup.realtimeChannelSend(),
      })
    })

    it('should satisfy the serverless ownership contract (error path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.messaging.send',
        scenario: 'error',
        expectedSpan:
        {
          name: 'supabase.messaging.send',
          service: 'test',
          resource: 'test-room',
          type: 'messaging',
          meta: {
            component: 'supabase',
            'span.kind': 'producer',
            'messaging.system': 'supabase',
            'messaging.destination.name': 'test-room',
            'messaging.destination.kind': 'topic',
            'messaging.operation': 'send',
            'error.type': 'RealtimeSendError',
            'error.message': 'Realtime send returned error',
            'error.stack': ANY_STRING,
          },
          metrics: {},
          error: 1,
        },
        run: () => testSetup.realtimeChannelSendError(),
      })
    })
  })

  describe('FunctionsClient.invoke() - supabase.http.invoke', () => {
    it('should satisfy the serverless ownership contract (happy path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.http.invoke',
        scenario: 'happy',
        expectedSpan:
        {
          name: 'supabase.http.invoke',
          service: 'test',
          resource: 'POST /functions/v1/hello',
          type: 'http',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'POST',
            'http.url': 'https://project.supabase.co/functions/v1/hello',
            'http.status_code': '200',
            'faas.invoked_name': 'hello',
          },
          metrics: {},
        },
        run: () => testSetup.functionsClientInvoke(),
      })
    })

    it('should satisfy the serverless ownership contract (error path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.http.invoke',
        scenario: 'error',
        expectedSpan:
        {
          name: 'supabase.http.invoke',
          service: 'test',
          resource: 'POST /functions/v1/hello',
          type: 'http',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'POST',
            'http.url': 'https://project.supabase.co/functions/v1/hello',
            'http.status_code': '500',
            'faas.invoked_name': 'hello',
            'error.type': 'FunctionsHttpError',
            'error.message': 'Edge Function returned a non-2xx status code',
            'error.stack': ANY_STRING,
          },
          metrics: {},
          error: 1,
        },
        run: () => testSetup.functionsClientInvokeError(),
      })
    })

    it('captures an explicit HTTP method', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.http.invoke',
        scenario: 'happy',
        expectedSpan: {
          name: 'supabase.http.invoke',
          service: 'test',
          resource: 'DELETE /functions/v1/hello',
          type: 'http',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'DELETE',
            'http.url': 'https://project.supabase.co/functions/v1/hello',
            'http.status_code': '200',
            'faas.invoked_name': 'hello',
          },
          metrics: {},
        },
        run: () => testSetup.functionsClientInvokeDelete(),
      })
    })
  })

  describe('PostgrestBuilder.then() - supabase.database.query', () => {
    it('should satisfy the serverless ownership contract (happy path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.database.query',
        scenario: 'happy',
        expectedSpan:
        {
          name: 'supabase.database.query',
          service: 'test',
          resource: 'SELECT items',
          type: 'sql',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'db.type': 'postgres',
            'db.name': 'public',
            'db.operation': 'SELECT',
            'out.host': 'project.supabase.co',
          },
          metrics: {},
        },
        run: () => testSetup.postgrestBuilderThen(),
      })
    })

    it('should satisfy the serverless ownership contract (error path)', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.database.query',
        scenario: 'error',
        expectedSpan:
        {
          name: 'supabase.database.query',
          service: 'test',
          resource: 'SELECT items',
          type: 'sql',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'db.type': 'postgres',
            'db.name': 'public',
            'db.operation': 'SELECT',
            'out.host': 'project.supabase.co',
            'error.type': 'PostgrestError',
            'error.message': 'Database unavailable',
            'error.stack': ANY_STRING,
          },
          metrics: {},
          error: 1,
        },
        run: () => testSetup.postgrestBuilderThenError(),
      })
    })

    const operationCases = [
      ['HEAD requests', 'SELECT', 'SELECT items', () => testSetup.postgrestBuilderThenHead()],
      ['inserts', 'INSERT', 'INSERT items', () => testSetup.postgrestBuilderThenInsert()],
      ['updates', 'UPDATE', 'UPDATE items', () => testSetup.postgrestBuilderThenUpdate()],
      ['deletes', 'DELETE', 'DELETE items', () => testSetup.postgrestBuilderThenDelete()],
      ['RPC calls', 'CALL', 'CALL refresh_items', () => testSetup.postgrestBuilderThenRpc()],
    ]

    for (const [name, operation, resource, run] of operationCases) {
      it(`maps ${name} to database metadata`, async () => {
        return runServerlessContract({
          agent,
          tracer: meta.tracer,
          operationName: 'supabase.database.query',
          scenario: 'happy',
          expectedSpan: {
            name: 'supabase.database.query',
            service: 'test',
            resource,
            type: 'sql',
            meta: {
              component: 'supabase',
              'span.kind': 'client',
              'db.type': 'postgres',
              'db.name': 'public',
              'db.operation': operation,
              'out.host': 'project.supabase.co',
            },
            metrics: {},
          },
          run,
        })
      })
    }
  })

  describe('transport rejections', () => {
    const cases = [
      {
        name: 'GoTrueClient.getUser() returns an AuthRetryableFetchError',
        operationName: 'supabase.http.getuser',
        expectedSpan: {
          name: 'supabase.http.getuser',
          service: 'test',
          resource: 'GET /auth/v1/user',
          type: 'http',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'GET',
            'http.url': 'https://project.supabase.co/auth/v1/user',
            'error.type': 'AuthRetryableFetchError',
            'error.message': 'Supabase request failed',
            'error.stack': ANY_STRING,
          },
          error: 1,
        },
        run: () => testSetup.goTrueClientGetUserTransportError(),
      },
      {
        name: 'StorageBucketApi.listBuckets() returns a StorageUnknownError',
        operationName: 'supabase.storage.request',
        expectedSpan: {
          name: 'supabase.storage.request',
          service: 'test',
          resource: 'GET bucket',
          type: 'storage',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'GET',
            'http.url': 'https://project.supabase.co/storage/v1/bucket',
            'error.type': 'StorageUnknownError',
            'error.message': 'Supabase request failed',
            'error.stack': ANY_STRING,
          },
          error: 1,
        },
        run: () => testSetup.storageBucketApiListBucketsTransportError(),
      },
      {
        name: 'RealtimeChannel.send() returns error',
        operationName: 'supabase.messaging.send',
        expectedSpan: {
          name: 'supabase.messaging.send',
          service: 'test',
          resource: 'test-room',
          type: 'messaging',
          meta: {
            component: 'supabase',
            'span.kind': 'producer',
            'messaging.system': 'supabase',
            'messaging.destination.name': 'test-room',
            'messaging.destination.kind': 'topic',
            'messaging.operation': 'send',
            'error.type': 'RealtimeSendError',
            'error.message': 'Realtime send returned error',
            'error.stack': ANY_STRING,
          },
          error: 1,
        },
        run: () => testSetup.realtimeChannelSendTransportError(),
      },
      {
        name: 'FunctionsClient.invoke() returns a FunctionsFetchError',
        operationName: 'supabase.http.invoke',
        expectedSpan: {
          name: 'supabase.http.invoke',
          service: 'test',
          resource: 'POST /functions/v1/hello',
          type: 'http',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'http.method': 'POST',
            'http.url': 'https://project.supabase.co/functions/v1/hello',
            'faas.invoked_name': 'hello',
            'error.type': 'FunctionsFetchError',
            'error.message': 'Failed to send a request to the Edge Function',
            'error.stack': ANY_STRING,
          },
          error: 1,
        },
        run: () => testSetup.functionsClientInvokeTransportError(),
      },
      {
        name: 'PostgrestBuilder.then() returns a PostgrestError',
        operationName: 'supabase.database.query',
        expectedSpan: {
          name: 'supabase.database.query',
          service: 'test',
          resource: 'SELECT items',
          type: 'sql',
          meta: {
            component: 'supabase',
            'span.kind': 'client',
            'db.type': 'postgres',
            'db.name': 'public',
            'db.operation': 'SELECT',
            'out.host': 'project.supabase.co',
            'error.type': 'PostgrestError',
            'error.message': 'Error: Supabase request failed',
            'error.stack': ANY_STRING,
          },
          error: 1,
        },
        run: () => testSetup.postgrestBuilderThenTransportError(),
      },
      {
        name: 'RealtimeChannel.send() returns timed out',
        operationName: 'supabase.messaging.send',
        expectedSpan: {
          name: 'supabase.messaging.send',
          service: 'test',
          resource: 'test-room',
          type: 'messaging',
          meta: {
            component: 'supabase',
            'span.kind': 'producer',
            'messaging.system': 'supabase',
            'messaging.destination.name': 'test-room',
            'messaging.destination.kind': 'topic',
            'messaging.operation': 'send',
            'error.type': 'RealtimeSendError',
            'error.message': 'Realtime send returned timed out',
            'error.stack': ANY_STRING,
          },
          error: 1,
        },
        run: () => testSetup.realtimeChannelSendTimeout(),
      },
    ]

    for (const testCase of cases) {
      it(testCase.name, async () => {
        return runServerlessContract({
          agent,
          tracer: meta.tracer,
          operationName: testCase.operationName,
          scenario: 'error',
          expectedSpan: testCase.expectedSpan,
          run: testCase.run,
        })
      })
    }

    it('preserves GoTrueClient.getUser() opt-in rejection behavior', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.http.getuser',
        scenario: 'error',
        expectedSpan: cases[0].expectedSpan,
        run: () => testSetup.goTrueClientGetUserRejected(),
        shouldReject: true,
      })
    })

    it('preserves StorageBucketApi.listBuckets() opt-in rejection behavior', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.storage.request',
        scenario: 'error',
        expectedSpan: cases[1].expectedSpan,
        run: () => testSetup.storageBucketApiListBucketsRejected(),
        shouldReject: true,
      })
    })

    it('preserves PostgrestBuilder.then() opt-in rejection behavior', async () => {
      return runServerlessContract({
        agent,
        tracer: meta.tracer,
        operationName: 'supabase.database.query',
        scenario: 'error',
        expectedSpan: {
          ...cases[4].expectedSpan,
          meta: {
            ...cases[4].expectedSpan.meta,
            'error.type': 'Error',
            'error.message': 'Supabase request failed',
          },
        },
        run: () => testSetup.postgrestBuilderThenRejected(),
        shouldReject: true,
      })
    })
  })

  describe('configuration', () => {
    it('uses the configured service for every operation', async () => {
      agent.reload('supabase', { service: 'custom-supabase' })

      try {
        const operations = [
          ['supabase.storage.request', () => testSetup.storageFileList()],
          ['supabase.http.getuser', () => testSetup.goTrueClientGetUser()],
          ['supabase.storage.request', () => testSetup.storageBucketApiListBuckets()],
          ['supabase.messaging.send', () => testSetup.realtimeChannelSend()],
          ['supabase.http.invoke', () => testSetup.functionsClientInvoke()],
          ['supabase.database.query', () => testSetup.postgrestBuilderThen()],
        ]

        for (const [operationName, run] of operations) {
          await runServerlessContract({
            agent,
            tracer: meta.tracer,
            operationName,
            scenario: 'happy',
            expectedSpan: {
              name: operationName,
              service: 'custom-supabase',
              meta: { component: 'supabase' },
            },
            run,
          })
        }
      } finally {
        agent.reload('supabase', {})
      }
    })

    it('preserves behavior when disabled', async () => {
      const receivedTraces = []
      const collectTraces = traces => receivedTraces.push(...traces)
      agent.reload('supabase', false)
      agent.subscribe(collectTraces)

      const rootTraceAssertion = agent.assertSomeTraces((traces) => {
        assert.ok(traces.flat().some(span => span.name === serverlessRootName))
      }, { spanResourceMatch: new RegExp(serverlessRootName.replaceAll('.', '\\.')) })

      try {
        const result = await meta.tracer.trace(serverlessRootName, async () => testSetup.storageFileList())
        await rootTraceAssertion

        assert.strictEqual(result.error, null)
        assert.strictEqual(receivedTraces.flat().some(span => span.meta?.component === 'supabase'), false)
      } finally {
        agent.unsubscribe(collectTraces)
        agent.reload('supabase', {})
      }
    })
  })
})

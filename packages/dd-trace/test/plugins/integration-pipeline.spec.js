'use strict'

const assert = require('node:assert/strict')

const { after, before, describe, it } = require('mocha')
const dc = require('dc-polyfill')
const { storage } = require('../../../datadog-core')

require('../setup/core')

const {
  argument,
  createIntegrationPlugin,
  field,
  result,
  self,
} = require('../../src/plugins/integration-pipeline')
const plugins = require('../../src/plugins')
const agent = require('./agent')

const integrationName = 'commonPlugin'
const stageEvents = []
const contextStorage = storage('context')
const spanStorage = storage('span')
const legacyStorage = storage('legacy')
const resultStatus = result('status')

function extractOptionalTrace (invocation) {
  if (invocation.arguments[0].failExtractor) throw new Error('author extractor failed')
  return invocation.arguments[0].trace
}

function extractStatus (invocation, frame) {
  if (frame.data.operation === 'throw-complete') throw new Error('complete extractor failed')
  return resultStatus(invocation)
}

function resolveStatusTag (frame) {
  if (frame.data.operation === 'throw-result-tags') throw new Error('result tag resolver failed')
  return frame.data.status
}

const correlationStage = {
  name: 'correlation',
  start (frame) {
    assert.strictEqual(contextStorage.getStore().correlation, frame.correlation)
    assert.strictEqual(spanStorage.getStore()?.span, undefined)
    assert.strictEqual(Object.hasOwn(frame, 'span'), false)
    assert.strictEqual(Object.hasOwn(frame, 'state'), false)
    stageEvents.push('correlation:start')
    frame.invocation.arguments[1].reservedTraceId = frame.correlation.traceId
    frame.invocation.arguments[1].reservedSpanId = frame.correlation.spanId
    frame.trace.setTag('example.correlation_stage', 'true')
  },
  complete () {
    stageEvents.push('correlation:complete')
  },
  error () {
    stageEvents.push('correlation:error')
  },
}

const propagationStage = {
  name: 'propagation',
  requires: ['tracing'],
  start (frame) {
    assert.ok(spanStorage.getStore()?.span)
    assert.strictEqual(Object.hasOwn(frame, 'span'), false)
    assert.strictEqual(Object.hasOwn(frame, 'plugin'), false)
    assert.strictEqual(Object.hasOwn(frame, 'tracer'), false)
    stageEvents.push('propagation:start')
    frame.correlation.inject('text_map', frame.invocation.arguments[1])
  },
  complete () {
    stageEvents.push('propagation:complete')
  },
  error () {
    stageEvents.push('propagation:error')
  },
}

const telemetryStage = {
  name: 'telemetry',
  requires: ['tracing'],
  start () {
    stageEvents.push('telemetry:start')
  },
  complete () {
    stageEvents.push('telemetry:complete')
  },
  error () {
    stageEvents.push('telemetry:error')
  },
}

const contextOnlyStage = {
  name: 'context-only',
  start (frame) {
    stageEvents.push('context-only:start')
    frame.invocation.arguments[0].traceId = frame.correlation.traceId
    frame.invocation.arguments[0].spanId = frame.correlation.spanId
  },
  complete () {
    stageEvents.push('context-only:complete')
  },
}

const optionalContextStage = {
  name: 'optional-context',
  start (frame) {
    stageEvents.push('optional-context:start')
    if (frame.invocation.arguments[0].failStage) throw new Error('stage failed')
  },
  complete () {
    stageEvents.push('optional-context:complete')
  },
}

const PipelinePlugin = createIntegrationPlugin({
  id: integrationName,
  operations: [
    {
      target: { module: '@example/client', name: 'Client_request' },
      lifecycle: 'async',
      extract: {
        start: {
          operation: argument(0, 'operation'),
          peer: self('host'),
        },
        complete: {
          status: extractStatus,
        },
      },
      when: frame => frame.data.operation !== 'ignored',
      span: {
        name: 'example.request',
        resource: field('operation'),
        service: frame => frame.config.service,
        type: 'custom',
        kind: 'client',
        tags: {
          'example.peer': field('peer'),
        },
        resultTags: {
          'example.status': resolveStatusTag,
        },
      },
      stages: [correlationStage, propagationStage, telemetryStage],
    },
    {
      target: { module: '@example/client', name: 'Client_ping' },
      lifecycle: 'sync',
      extract: {
        start: invocation => ({ resource: invocation.arguments[0] }),
        complete: invocation => ({ status: invocation.result.status }),
      },
      span: {
        name: 'example.ping',
        resource: field('resource'),
        type: 'custom',
        kind: 'client',
        tags: () => ({ 'example.tag_block': 'resolved' }),
        resultTags: { 'example.status': field('status') },
      },
    },
    {
      target: { module: '@example/client', name: 'Client_ids' },
      lifecycle: 'sync',
      stages: [contextOnlyStage],
    },
    {
      target: { module: '@example/client', name: 'Client_optional' },
      lifecycle: 'sync',
      extract: { start: { trace: extractOptionalTrace } },
      span: {
        enabled: field('trace'),
        name: 'example.optional',
      },
      stages: [optionalContextStage, telemetryStage],
    },
    {
      target: { module: '@example/client', name: 'Client_child' },
      lifecycle: 'sync',
      context: { parent: () => undefined },
      span: { name: 'example.child' },
    },
  ],
})

describe('IntegrationPipeline', () => {
  const requestChannel = dc.tracingChannel('orchestrion:@example/client:Client_request')
  const pingChannel = dc.tracingChannel('orchestrion:@example/client:Client_ping')
  const idsChannel = dc.tracingChannel('orchestrion:@example/client:Client_ids')
  const optionalChannel = dc.tracingChannel('orchestrion:@example/client:Client_optional')
  const childChannel = dc.tracingChannel('orchestrion:@example/client:Client_child')
  let tracer

  before(async () => {
    tracer = await agent.load()
    plugins['@example/client'] = PipelinePlugin
    dc.channel('dd-trace:instrumentation:load').publish({ name: '@example/client' })
    agent.reload(integrationName, { service: 'example-service' })
  })

  after(async () => {
    delete plugins['@example/client']
    await agent.close()
  })

  beforeEach(() => {
    stageEvents.length = 0
  })

  it('runs correlation before tracing and materializes the reserved IDs', async () => {
    const carrier = {}
    const invocation = {
      arguments: [{ operation: 'fetch' }, carrier],
      self: { host: 'api.example.test' },
    }

    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'example.request')
      assert.strictEqual(span.service, 'example-service')
      assert.strictEqual(span.resource, 'fetch')
      assert.strictEqual(span.meta['span.kind'], 'client')
      assert.strictEqual(span.type, 'custom')
      assert.strictEqual(span.meta['example.peer'], 'api.example.test')
      assert.strictEqual(span.meta.example_correlation_stage, undefined)
      assert.strictEqual(span.meta['example.correlation_stage'], 'true')
      assert.strictEqual(span.metrics['example.status'], 202)
      assert.strictEqual(span.trace_id.toString(), carrier.reservedTraceId)
      assert.strictEqual(span.span_id.toString(), carrier.reservedSpanId)
      assert.strictEqual(carrier['x-datadog-trace-id'], carrier.reservedTraceId)
      assert.strictEqual(carrier['x-datadog-parent-id'], carrier.reservedSpanId)
    })

    const resultPromise = requestChannel.tracePromise(
      () => Promise.resolve({ status: 202 }),
      invocation
    )

    assert.ok(carrier['x-datadog-trace-id'])
    await Promise.all([assertion, resultPromise])
    assert.deepStrictEqual(stageEvents, [
      'correlation:start',
      'propagation:start',
      'telemetry:start',
      'telemetry:complete',
      'propagation:complete',
      'correlation:complete',
    ])
    assert.strictEqual(contextStorage.getStore(), undefined)
    assert.strictEqual(spanStorage.getStore(), undefined)
  })

  it('records errors and unwinds every started stage', async () => {
    const error = new Error('request failed')
    const invocation = {
      arguments: [{ operation: 'reject' }, {}],
      self: { host: 'api.example.test' },
    }

    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'example.request')
      assert.strictEqual(span.resource, 'reject')
      assert.strictEqual(span.error, 1)
      assert.strictEqual(span.meta['error.message'], error.message)
    })

    const resultPromise = requestChannel.tracePromise(
      () => Promise.reject(error),
      invocation
    )

    await Promise.all([assertion, assert.rejects(resultPromise, error)])
    assert.deepStrictEqual(stageEvents, [
      'correlation:start',
      'propagation:start',
      'telemetry:start',
      'telemetry:error',
      'propagation:error',
      'correlation:error',
      'telemetry:complete',
      'propagation:complete',
      'correlation:complete',
    ])
  })

  it('supports a second synchronous traced operation', async () => {
    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'example.ping')
      assert.strictEqual(span.resource, 'ping')
      assert.strictEqual(span.meta.example_tag_block, undefined)
      assert.strictEqual(span.meta['example.tag_block'], 'resolved')
      assert.strictEqual(span.metrics['example.status'], 204)
    })

    const result = pingChannel.traceSync(() => ({ status: 204 }), { arguments: ['ping'] })
    assert.deepStrictEqual(result, { status: 204 })
    await assertion
  })

  it('skips unused capability blocks inside a legacy noop scope', async () => {
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('noop-nested stage-free operation unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    const value = legacyStorage.run({ noop: true }, () => pingChannel.traceSync(() => {
      assert.deepStrictEqual(legacyStorage.getStore(), { noop: true })
      assert.strictEqual(contextStorage.getStore(), undefined)
      assert.strictEqual(spanStorage.getStore(), undefined)
      return 'noop-pong'
    }, { arguments: [] }))

    assert.strictEqual(value, 'noop-pong')
    await noTraces
  })

  it('runs an operation with correlation context and no span', async () => {
    const ids = {}
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('context-only operation unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    const value = idsChannel.traceSync(() => {
      assert.strictEqual(contextStorage.getStore().correlation.traceId, ids.traceId)
      assert.strictEqual(contextStorage.getStore().correlation.spanId, ids.spanId)
      assert.strictEqual(spanStorage.getStore()?.span, undefined)
      return 'ids'
    }, { arguments: [ids] })

    assert.strictEqual(value, 'ids')
    assert.ok(ids.traceId)
    assert.ok(ids.spanId)
    assert.deepStrictEqual(stageEvents, ['context-only:start', 'context-only:complete'])
    assert.strictEqual(contextStorage.getStore(), undefined)
    await noTraces
  })

  it('runs correlation stages even inside a legacy noop scope', () => {
    const ids = {}

    const value = legacyStorage.run({ noop: true }, () => idsChannel.traceSync(() => {
      assert.strictEqual(contextStorage.getStore().correlation.traceId, ids.traceId)
      assert.deepStrictEqual(legacyStorage.getStore(), { noop: true })
      return 'nested-ids'
    }, { arguments: [ids] }))

    assert.strictEqual(value, 'nested-ids')
    assert.ok(ids.traceId)
    assert.deepStrictEqual(stageEvents, ['context-only:start', 'context-only:complete'])
  })

  it('keeps correlation active but suppresses tracing inside a legacy noop scope', async () => {
    const carrier = {}
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('noop-nested operation unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    const value = await legacyStorage.run({ noop: true }, () => requestChannel.tracePromise(
      () => Promise.resolve('nested-request'),
      {
        arguments: [{ operation: 'nested' }, carrier],
        self: { host: 'api.example.test' },
      }
    ))

    assert.strictEqual(value, 'nested-request')
    assert.ok(carrier.reservedTraceId)
    assert.strictEqual(carrier['x-datadog-trace-id'], undefined)
    assert.deepStrictEqual(stageEvents, ['correlation:start', 'correlation:complete'])
    await noTraces
  })

  it('can disable tracing without disabling correlation stages', async () => {
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('trace-disabled operation unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    assert.strictEqual(optionalChannel.traceSync(() => 'untraced', {
      arguments: [{ trace: false }],
    }), 'untraced')

    assert.deepStrictEqual(stageEvents, ['optional-context:start', 'optional-context:complete'])
    await noTraces
  })

  it('isolates stage failures and still runs terminal cleanup', async () => {
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('stage-failure operation unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    assert.strictEqual(optionalChannel.traceSync(() => 'completed', {
      arguments: [{ trace: false, failStage: true }],
    }), 'completed')

    assert.deepStrictEqual(stageEvents, ['optional-context:start', 'optional-context:complete'])
    assert.strictEqual(contextStorage.getStore(), undefined)
    assert.strictEqual(spanStorage.getStore(), undefined)
    await noTraces
  })

  it('does not let a throwing extractor escape into the instrumented application', async () => {
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('extractor-failure operation unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    const result = optionalChannel.traceSync(() => 'library-result', {
      arguments: [{ failExtractor: true }],
    })

    assert.strictEqual(result, 'library-result')
    assert.deepStrictEqual(stageEvents, [])
    await new Promise(resolve => setImmediate(resolve))
    await noTraces
  })

  it('isolates a throwing completion extractor and still unwinds stages and finishes the span', async () => {
    const invocation = {
      arguments: [{ operation: 'throw-complete' }, {}],
      self: { host: 'api.example.test' },
    }
    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'example.request')
      assert.strictEqual(span.resource, 'throw-complete')
      assert.strictEqual(span.meta['example.status'], undefined)
    })

    const resultPromise = requestChannel.tracePromise(() => Promise.resolve({ status: 202 }), invocation)

    assert.deepStrictEqual(await resultPromise, { status: 202 })
    await assertion
    assert.deepStrictEqual(stageEvents, [
      'correlation:start',
      'propagation:start',
      'telemetry:start',
      'telemetry:complete',
      'propagation:complete',
      'correlation:complete',
    ])
  })

  it('isolates a throwing result-tag resolver and still unwinds stages and finishes the span', async () => {
    const invocation = {
      arguments: [{ operation: 'throw-result-tags' }, {}],
      self: { host: 'api.example.test' },
    }
    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'example.request')
      assert.strictEqual(span.resource, 'throw-result-tags')
      assert.strictEqual(span.meta['example.status'], undefined)
    })

    const resultPromise = requestChannel.tracePromise(() => Promise.resolve({ status: 202 }), invocation)

    assert.deepStrictEqual(await resultPromise, { status: 202 })
    await assertion
    assert.deepStrictEqual(stageEvents, [
      'correlation:start',
      'propagation:start',
      'telemetry:start',
      'telemetry:complete',
      'propagation:complete',
      'correlation:complete',
    ])
  })

  it('inherits the active parent when an explicit parent resolver returns undefined', async () => {
    const parent = tracer.startSpan('example.parent')
    const assertion = agent.assertSomeTraces(traces => {
      const spans = traces[0]
      const parentSpan = spans.find(span => span.name === 'example.parent')
      const childSpan = spans.find(span => span.name === 'example.child')

      assert.ok(parentSpan)
      assert.ok(childSpan)
      assert.strictEqual(childSpan.trace_id.toString(), parentSpan.trace_id.toString())
      assert.strictEqual(childSpan.parent_id.toString(), parentSpan.span_id.toString())
    })

    const result = legacyStorage.run({ span: parent }, () => childChannel.traceSync(() => 'child-result', {
      arguments: [],
    }))
    parent.finish()

    assert.strictEqual(result, 'child-result')
    await assertion
  })

  it('applies a gate before allocating context, tracing, or stages', async () => {
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('ignored operation unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    const value = await requestChannel.tracePromise(
      () => Promise.resolve({ status: 204 }),
      {
        arguments: [{ operation: 'ignored' }, {}],
        self: { host: 'api.example.test' },
      }
    )

    assert.deepStrictEqual(value, { status: 204 })
    assert.deepStrictEqual(stageEvents, [])
    await noTraces
  })

  it('rejects invalid definitions before registering subscriptions', () => {
    assert.throws(
      () => createIntegrationPlugin({ id: '', operations: [] }),
      { message: 'Integration pipeline requires a non-empty id' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [] }),
      { message: 'Integration pipeline "invalid" requires at least one operation' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        base: class {},
        operations: [{ target: { module: 'example', name: 'request' }, lifecycle: 'sync' }],
      }),
      { message: 'Integration pipeline "invalid" definition has an unknown "base" field' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [{ target: {} }] }),
      { message: 'Integration pipeline "invalid" has an invalid target' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ target: { module: 'example', name: 'request' }, lifecycle: 'callback' }],
      }),
      { message: 'Integration operation "request" requires a sync or async lifecycle' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ target: { module: 'example', name: 'request' }, lifecycle: 'sync', skip: 'invalid' }],
      }),
      { message: 'Integration operation "request" has an invalid skip mode' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{
          target: { module: 'example', name: 'request' },
          lifecycle: 'sync',
          span: {},
        }],
      }),
      { message: 'Integration operation "request" requires a span name or resolver' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{
          target: { module: 'example', name: 'request' },
          lifecycle: 'sync',
          stages: [{ name: 'trace-only', requires: ['tracing'] }],
        }],
      }),
      { message: 'Integration stage "trace-only" requires tracing but the operation does not trace' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [
          { target: { module: 'example', name: 'request' }, lifecycle: 'sync' },
          { target: { module: 'example', name: 'request' }, lifecycle: 'async' },
        ],
      }),
      { message: 'Integration pipeline "invalid" repeats target "example:request"' }
    )
  })

  it('rejects malformed extractors, gates, spans, and stages', () => {
    const operation = {
      target: { module: 'example', name: 'request' },
      lifecycle: 'sync',
    }

    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [null] }),
      { message: 'Integration pipeline "invalid" has an invalid operation' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [{ ...operation, extract: null }] }),
      { message: 'Integration operation "request" has an invalid extract definition' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ ...operation, extract: { start: { resource: 'not-a-function' } } }],
      }),
      { message: 'Integration operation "request" extract.start field "resource" requires an extractor function' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ ...operation, extract: { completed: () => ({}) } }],
      }),
      { message: 'Integration operation "request" extract definition has an unknown "completed" field' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ ...operation, extract: { complete: [] } }],
      }),
      { message: 'Integration operation "request" extract.complete must be a function or field record' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [{ ...operation, when: true }] }),
      { message: 'Integration operation "request" requires a when function' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [{ ...operation, span: [] }] }),
      { message: 'Integration operation "request" has an invalid span definition' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [{ ...operation, span: { name: {} } }] }),
      { message: 'Integration operation "request" requires a span name or resolver' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ ...operation, span: { name: 'example.request', resultTags: [] } }],
      }),
      { message: 'Integration operation "request" span resultTags must be a function or field record' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [{ ...operation, stages: {} }] }),
      { message: 'Integration operation "request" requires a stage list' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [{ ...operation, stages: [null] }] }),
      { message: 'Integration operation "request" has an invalid stage' }
    )
    assert.throws(
      () => createIntegrationPlugin({ id: 'invalid', operations: [{ ...operation, stages: [{ name: '' }] }] }),
      { message: 'Integration operation "request" has a stage without a non-empty name' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ ...operation, stages: [{ name: 'bad', statr () {} }] }],
      }),
      { message: 'Integration operation "request" stage has an unknown "statr" field' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ ...operation, stages: [{ name: 'bad', requires: 'tracing' }] }],
      }),
      { message: 'Integration stage "bad" requires a capability list' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{ ...operation, stages: [{ name: 'bad', start: true }] }],
      }),
      { message: 'Integration stage "bad" has an invalid start hook' }
    )
    assert.throws(
      () => createIntegrationPlugin({
        id: 'invalid',
        operations: [{
          ...operation,
          span: { name: 'example.request' },
          stages: [{ name: 'bad', requires: ['unknown'] }],
        }],
      }),
      { message: 'Integration stage "bad" requires an unknown capability' }
    )
  })
})

'use strict'

const assert = require('node:assert/strict')

const { after, before, describe, it } = require('mocha')
const dc = require('dc-polyfill')

require('../setup/core')

const {
  argument,
  createOrchestrionPlugin,
  field,
  result,
  self,
} = require('../../src/plugins/orchestrion-pipeline')
const plugins = require('../../src/plugins')
const agent = require('./agent')

// Reuse the test-only supported configuration key already reserved by tracing.spec.js.
const integrationName = 'commonPlugin'
const stageEvents = []

const propagationStage = {
  name: 'propagation',
  start (frame) {
    assert.strictEqual(frame.plugin.activeSpan, frame.span)
    stageEvents.push('propagation:start')
    frame.context.arguments[1].traceId = frame.span.context().toTraceId()
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

const PipelinePlugin = createOrchestrionPlugin({
  id: integrationName,
  operations: [
    {
      target: {
        module: '@example/client',
        name: 'Client_request',
      },
      lifecycle: 'async',
      extract: {
        start: {
          operation: argument(0, 'operation'),
          peer: self('host'),
        },
        complete: {
          status: result('status'),
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
          'example.status': field('status'),
        },
      },
      stages: [propagationStage, telemetryStage],
    },
    {
      target: {
        module: '@example/client',
        name: 'Client_ping',
      },
      lifecycle: 'sync',
      span: {
        name: 'example.ping',
        resource: 'ping',
        type: 'custom',
        kind: 'client',
      },
    },
  ],
})

describe('Orchestrion integration pipeline PoC', () => {
  const requestChannel = dc.tracingChannel('orchestrion:@example/client:Client_request')
  const pingChannel = dc.tracingChannel('orchestrion:@example/client:Client_ping')

  before(async () => {
    await agent.load()
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

  it('extracts semantic data and runs ordered stages for an async operation', async () => {
    const carrier = {}
    const context = {
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
      assert.strictEqual(span.metrics['example.status'], 202)
    })

    const invocation = requestChannel.tracePromise(
      () => Promise.resolve({ status: 202 }),
      context
    )

    assert.ok(carrier.traceId)
    await Promise.all([assertion, invocation])
    assert.deepStrictEqual(stageEvents, [
      'propagation:start',
      'telemetry:start',
      'telemetry:complete',
      'propagation:complete',
    ])
  })

  it('records errors and unwinds error stages for an async rejection', async () => {
    const error = new Error('request failed')
    const context = {
      arguments: [{ operation: 'reject' }, {}],
      self: { host: 'api.example.test' },
    }

    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'example.request')
      assert.strictEqual(span.resource, 'reject')
      assert.strictEqual(span.error, 1)
      assert.strictEqual(span.meta['error.message'], error.message)
    })

    const invocation = requestChannel.tracePromise(
      () => Promise.reject(error),
      context
    )

    await Promise.all([
      assertion,
      assert.rejects(invocation, error),
    ])
    assert.deepStrictEqual(stageEvents, [
      'propagation:start',
      'telemetry:start',
      'telemetry:error',
      'propagation:error',
      'telemetry:complete',
      'propagation:complete',
    ])
  })

  it('supports a second synchronous operation without another plugin class', async () => {
    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'example.ping')
      assert.strictEqual(span.resource, 'ping')
    })

    assert.strictEqual(pingChannel.traceSync(() => 'pong', { arguments: [] }), 'pong')
    await assertion
  })

  it('applies a declarative gate before creating a span or running stages', async () => {
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('ignored operation unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    const result = await requestChannel.tracePromise(
      () => Promise.resolve({ status: 204 }),
      {
        arguments: [{ operation: 'ignored' }, {}],
        self: { host: 'api.example.test' },
      }
    )

    assert.deepStrictEqual(result, { status: 204 })
    assert.deepStrictEqual(stageEvents, [])
    await noTraces
  })

  it('rejects incomplete definitions before registering subscriptions', () => {
    assert.throws(
      () => createOrchestrionPlugin({ id: '', operations: [] }),
      { message: 'Orchestrion integration requires a non-empty id' }
    )
    assert.throws(
      () => createOrchestrionPlugin({ id: 'invalid', operations: [] }),
      { message: 'Orchestrion integration "invalid" requires at least one operation' }
    )
    assert.throws(
      () => createOrchestrionPlugin({ id: 'invalid', operations: [{ target: {} }] }),
      { message: 'Orchestrion integration "invalid" has an invalid target' }
    )
    assert.throws(
      () => createOrchestrionPlugin({
        id: 'invalid',
        operations: [{ target: { module: 'example', name: 'request' }, lifecycle: 'callback' }],
      }),
      { message: 'Orchestrion operation "request" requires a sync or async lifecycle' }
    )
    assert.throws(
      () => createOrchestrionPlugin({
        id: 'invalid',
        operations: [{ target: { module: 'example', name: 'request' }, lifecycle: 'sync' }],
      }),
      { message: 'Orchestrion operation "request" requires a span name' }
    )
    assert.throws(
      () => createOrchestrionPlugin({
        id: 'invalid',
        operations: [
          {
            target: { module: 'example', name: 'request' },
            lifecycle: 'sync',
            span: { name: 'example.request' },
          },
          {
            target: { module: 'example', name: 'request' },
            lifecycle: 'async',
            span: { name: 'example.request' },
          },
        ],
      }),
      { message: 'Orchestrion integration "invalid" repeats target "example:request"' }
    )
  })
})

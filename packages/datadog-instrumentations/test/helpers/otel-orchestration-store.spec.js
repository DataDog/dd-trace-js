'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { describe, it, beforeEach, afterEach } = require('mocha')

const {
  appendOrchestrationSpanToTraceState,
  parseOrchestrationMetaFromTraceContext,
  traceContextFromMeta,
} = require('../../src/helpers/otel-orchestration-meta')
const {
  publishOrchestrationSpanMetaSync,
  readOrchestrationSpanMetaSync,
} = require('../../src/helpers/otel-orchestration-store')
const { buildSpanParentContext } = require('../../src/helpers/azure-trace-context')

describe('otel-orchestration-meta', () => {
  it('builds traceparent from orchestration metadata', () => {
    assert.deepEqual(
      traceContextFromMeta({
        traceId: '00000000000000000000000000000001',
        spanId: '0000000000000002',
      }),
      {
        traceParent: '00-00000000000000000000000000000001-0000000000000002-01',
      },
    )
  })

  it('parses orchestration span id from tracestate', () => {
    assert.deepEqual(
      parseOrchestrationMetaFromTraceContext({
        traceParent: '00-00000000000000000000000000000001-0000000000000003-00',
        traceState: 'dd=s:1,dd=o:0000000000000002',
      }),
      {
        traceId: '00000000000000000000000000000001',
        spanId: '0000000000000002',
      },
    )
  })

  it('appends orchestration span id to tracestate', () => {
    assert.equal(
      appendOrchestrationSpanToTraceState('dd=s:1', '0000000000000002'),
      'dd=s:1,dd=o:0000000000000002',
    )
  })
})

describe('otel-orchestration-store', () => {
  let previousStoreDir

  beforeEach(() => {
    previousStoreDir = process.env.DD_ORCHESTRATION_STORE_DIR
    process.env.DD_ORCHESTRATION_STORE_DIR = path.join(
      os.tmpdir(),
      `dd-orch-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
  })

  afterEach(() => {
    if (previousStoreDir === undefined) {
      delete process.env.DD_ORCHESTRATION_STORE_DIR
    } else {
      process.env.DD_ORCHESTRATION_STORE_DIR = previousStoreDir
    }
  })

  it('writes and reads orchestration metadata from the shared store', () => {
    publishOrchestrationSpanMetaSync('abc123', {
      _ddSpan: {
        context () {
          return {
            _traceId: '00000000000000000000000000000001',
            _spanId: '0000000000000002',
          }
        },
      },
    })

    assert.deepEqual(
      readOrchestrationSpanMetaSync('abc123'),
      {
        traceId: '00000000000000000000000000000001',
        spanId: '0000000000000002',
      },
    )
    assert.ok(fs.existsSync(path.join(process.env.DD_ORCHESTRATION_STORE_DIR, 'abc123.json')))
  })

  it('parents activity spans to orchestration metadata from the shared store', () => {
    process.env.DD_TRACE_OTEL_ENABLED = 'true'
    process.env.DD_TRACE_AZURE_DURABLE_FUNCTIONS_ENABLED = 'false'

    const ddtrace = require('../../../dd-trace')
    ddtrace.init({ plugins: false, sampleRate: 1 })
    new ddtrace.TracerProvider().register()

    publishOrchestrationSpanMetaSync('abc123', {
      _ddSpan: {
        context () {
          return {
            _traceId: '00000000000000000000000000000001',
            _spanId: '0000000000000002',
          }
        },
      },
    })

    const activityContext = {
      traceContext: {
        traceParent: '00-00000000000000000000000000000001-0000000000000003-00',
        attributes: {
          'durabletask.task.instance_id': 'abc123',
        },
      },
    }

    const api = require('@opentelemetry/api')
    const parentContext = buildSpanParentContext(['input', activityContext], 'durable-activity')
    const actSpan = api.trace.getTracer('test').startSpan('durable-activity Test', {}, parentContext)
    assert.equal(actSpan._ddSpan.context()._parentId.toString(16).padStart(16, '0'), '0000000000000002')
    actSpan.end()
  })
})

'use strict'

const Module = require('module')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { describe, it, beforeEach, afterEach } = require('mocha')

const storePath = require.resolve('../../src/helpers/otel-orchestration-store')

const {
  appendOrchestrationSpanToTraceState,
  parseOrchestrationMetaFromTraceContext,
  traceContextFromMeta,
} = require('../../src/helpers/otel-orchestration-meta')
const {
  completeOrchestrationSpan,
  ensureOrchestrationMeta,
  injectOrchestrationMetaIntoTraceState,
  publishOrchestrationMetaSync,
  publishOrchestrationSpanMetaSync,
  readOrchestrationSpanMetaSync,
  reconcileOrchestrationHttpParent,
  seedOrchestrationMetaFromHttpParent,
} = require('../../src/helpers/otel-orchestration-store')
const {
  createOrchestrationMeta,
  createOrchestrationMetaFromHttpParent,
  exportOrchestrationSpanFromMeta,
  getParentFromTraceContext,
} = require('../../src/helpers/otel-orchestration-export')
const { publishHttpParentMeta } = require('../../src/helpers/otel-orchestration-http-link')
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
    previousStoreDir = process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR
    process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR = path.join(
      os.tmpdir(),
      `dd-orch-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
  })

  afterEach(() => {
    if (previousStoreDir === undefined) {
      delete process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR
    } else {
      process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR = previousStoreDir
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
        startTime: readOrchestrationSpanMetaSync('abc123').startTime,
        status: 'open',
      },
    )
    assert.ok(fs.existsSync(
      path.join(
        process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR,
        `${Buffer.from('abc123', 'utf8').toString('base64url')}.json`,
      ),
    ))
  })

  it('creates orchestration metadata once per instance', () => {
    const invocationContext = {
      traceContext: {
        traceParent: '00-00000000000000000000000000000001-0000000000000003-00',
      },
    }

    const first = ensureOrchestrationMeta('abc123', invocationContext, 'PizzaOrderOrchestration')
    const second = ensureOrchestrationMeta('abc123', invocationContext, 'PizzaOrderOrchestration')

    assert.equal(first.spanId, second.spanId)
    assert.equal(first.traceId, '00000000000000000000000000000001')
    assert.equal(first.status, 'open')
  })

  it('parents orchestration metadata to the HTTP span that started the instance', () => {
    publishHttpParentMeta('abc123', {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000004',
    })

    const meta = createOrchestrationMeta('abc123', {
      traceContext: {
        traceParent: '00-00000000000000000000000000000001-0000000000000099-00',
      },
    }, 'PizzaOrderOrchestration')

    assert.equal(meta.parentId, '0000000000000004')
    assert.equal(meta.traceId, '00000000000000000000000000000001')
  })

  it('reconciles orchestration metadata when the HTTP parent arrives after instance creation', () => {
    publishOrchestrationMetaSync('abc123', {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000002',
      parentId: '0000000000000099',
      startTime: Date.now(),
      status: 'open',
    })

    const updated = reconcileOrchestrationHttpParent('abc123', {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000004',
    })

    assert.equal(updated.parentId, '0000000000000004')
    assert.equal(updated.httpParentSpanId, '0000000000000004')
    assert.equal(readOrchestrationSpanMetaSync('abc123').parentId, '0000000000000004')
  })

  it('seeds orchestration metadata from the HTTP parent at startNew time', async () => {
    const meta = await seedOrchestrationMetaFromHttpParent('seed-new', {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000004',
    }, 'PizzaPartyOrchestration')

    assert.equal(meta.traceId, '00000000000000000000000000000001')
    assert.equal(meta.parentId, '0000000000000004')
    assert.equal(meta.spanId.length, 16)
    assert.ok(meta.startTime)
    assert.equal(meta.pendingStart, undefined)
    // A worker with no in-process state must still read the HTTP parent.
    assert.equal(readOrchestrationSpanMetaSync('seed-new').parentId, '0000000000000004')
  })

  it('keeps the seeded HTTP parent when the orchestration starts on another worker', async () => {
    await seedOrchestrationMetaFromHttpParent('seed-other-worker', {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000004',
    }, 'PizzaPartyOrchestration')

    const seeded = readOrchestrationSpanMetaSync('seed-other-worker')

    // Azure hands the orchestration its own unrelated trace context.
    const meta = ensureOrchestrationMeta('seed-other-worker', {
      traceContext: {
        traceParent: '00-99999999999999999999999999999999-0000000000000099-01',
      },
    }, 'PizzaPartyOrchestration')

    assert.equal(meta.parentId, '0000000000000004')
    assert.equal(meta.traceId, '00000000000000000000000000000001')
    assert.equal(meta.spanId, seeded.spanId)
    assert.strictEqual(meta.startTime, seeded.startTime)
  })

  it('does not seed twice for the same instance', async () => {
    const httpParent = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000004',
    }

    const first = await seedOrchestrationMetaFromHttpParent('seed-once', httpParent, 'PizzaPartyOrchestration')
    const second = await seedOrchestrationMetaFromHttpParent('seed-once', httpParent, 'PizzaPartyOrchestration')

    assert.equal(first.spanId, second.spanId)
  })

  it('prefers the stored HTTP parent over the tracestate marker', () => {
    publishOrchestrationMetaSync('abc123', {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000002',
      parentId: '0000000000000004',
      httpParentSpanId: '0000000000000004',
      startTime: Date.now(),
      status: 'open',
      functionName: 'PizzaPartyOrchestration',
    })

    const merged = readOrchestrationSpanMetaSync('abc123', {
      traceParent: '00-00000000000000000000000000000001-0000000000000099-00',
      traceState: 'dd=s:1,dd=o:0000000000000002',
    })

    assert.equal(merged.parentId, '0000000000000004')
    assert.equal(merged.httpParentSpanId, '0000000000000004')
    assert.equal(merged.spanId, '0000000000000002')
  })

  it('exports one orchestration span on completion', () => {
    process.env.DD_TRACE_OTEL_ENABLED = 'true'
    process.env.DD_TRACE_AZURE_DURABLE_FUNCTIONS_ENABLED = 'false'

    const ddtrace = require('../../../dd-trace')
    ddtrace.init({ plugins: false, sampleRate: 1 })
    new ddtrace.TracerProvider().register()

    const invocationContext = {
      traceContext: {
        traceParent: '00-00000000000000000000000000000001-0000000000000003-00',
      },
    }

    const meta = ensureOrchestrationMeta('abc123', invocationContext, 'PizzaOrderOrchestration')
    const complete = () => completeOrchestrationSpan(
      '@azure/durable-functions', 'abc123', invocationContext, 'PizzaOrderOrchestration'
    )
    assert.equal(complete(), true)
    assert.equal(complete(), false)
    assert.equal(readOrchestrationSpanMetaSync('abc123'), undefined)
    assert.equal(meta.spanId.length, 16)
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

  it('injects orchestration span ids into tracestate', () => {
    assert.deepEqual(
      injectOrchestrationMetaIntoTraceState(
        { traceState: 'dd=s:1' },
        { spanId: '0000000000000002' },
      ),
      { traceState: 'dd=s:1,dd=o:0000000000000002' },
    )
  })

  it('persists orchestration metadata to azure table storage', async () => {
    const previousStorage = process.env.AzureWebJobsStorage
    process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true'

    let upsertCalled = false
    delete require.cache[storePath]
    const originalRequire = Module.prototype.require
    Module.prototype.require = function (id) {
      if (id === '@azure/data-tables') {
        return {
          TableClient: {
            fromConnectionString (connectionString) {
              assert.match(connectionString, /127\.0\.0\.1:10002/)
              return {
                createTable: async () => {},
                upsertEntity: async () => { upsertCalled = true },
              }
            },
          },
        }
      }
      return originalRequire.apply(this, arguments)
    }

    try {
      const { publishOrchestrationMetaSync } = require('../../src/helpers/otel-orchestration-store')
      publishOrchestrationMetaSync('table-write', {
        traceId: '00000000000000000000000000000001',
        spanId: '0000000000000002',
        startTime: Date.now(),
        status: 'open',
      })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(upsertCalled, true)
    } finally {
      Module.prototype.require = originalRequire
      delete require.cache[storePath]
      if (previousStorage === undefined) {
        delete process.env.AzureWebJobsStorage
      } else {
        process.env.AzureWebJobsStorage = previousStorage
      }
    }
  })

  it('reads orchestration metadata from azure table storage', async () => {
    const previousStorage = process.env.AzureWebJobsStorage
    process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true'

    delete require.cache[storePath]
    const originalRequire = Module.prototype.require
    Module.prototype.require = function (id) {
      if (id === '@azure/data-tables') {
        return {
          TableClient: {
            fromConnectionString () {
              return {
                createTable: async () => {
                  const error = new Error('exists')
                  error.statusCode = 409
                  throw error
                },
                getEntity: async () => ({
                  traceId: '00000000000000000000000000000001',
                  spanId: '0000000000000005',
                  parentId: '0000000000000004',
                  status: 'open',
                  startTime: Date.now(),
                }),
              }
            },
          },
        }
      }
      return originalRequire.apply(this, arguments)
    }

    try {
      const { readOrchestrationSpanMetaAsync } = require('../../src/helpers/otel-orchestration-store')
      const meta = await readOrchestrationSpanMetaAsync('table-read')
      assert.equal(meta.spanId, '0000000000000005')
      assert.equal(meta.parentId, '0000000000000004')
    } finally {
      Module.prototype.require = originalRequire
      delete require.cache[storePath]
      if (previousStorage === undefined) {
        delete process.env.AzureWebJobsStorage
      } else {
        process.env.AzureWebJobsStorage = previousStorage
      }
    }
  })

  it('exports orchestration spans with errors', () => {
    process.env.DD_TRACE_OTEL_ENABLED = 'true'
    process.env.DD_TRACE_AZURE_DURABLE_FUNCTIONS_ENABLED = 'false'

    const ddtrace = require('../../../dd-trace')
    ddtrace.init({ plugins: false, sampleRate: 1 })
    new ddtrace.TracerProvider().register()

    const invocationContext = {
      traceContext: {
        traceParent: '00-00000000000000000000000000000001-0000000000000003-00',
      },
    }

    ensureOrchestrationMeta('error-inst', invocationContext, 'PizzaOrderOrchestration')
    assert.equal(
      completeOrchestrationSpan(
        '@azure/durable-functions',
        'error-inst',
        invocationContext,
        'PizzaOrderOrchestration',
        new Error('failed'),
      ),
      true,
    )
  })
})

describe('otel-orchestration-export', () => {
  it('ignores invalid traceparent headers', () => {
    assert.equal(getParentFromTraceContext({ traceParent: 'invalid' }), undefined)
  })

  it('ignores HTTP parent metadata without span ids', () => {
    assert.equal(createOrchestrationMetaFromHttpParent('inst', {}, 'Orch'), undefined)
  })

  it('exports orchestration spans directly from metadata', () => {
    process.env.DD_TRACE_OTEL_ENABLED = 'true'
    process.env.DD_TRACE_AZURE_DURABLE_FUNCTIONS_ENABLED = 'false'

    const ddtrace = require('../../../dd-trace')
    ddtrace.init({ plugins: false, sampleRate: 1 })
    new ddtrace.TracerProvider().register()

    assert.equal(exportOrchestrationSpanFromMeta('@azure/durable-functions', {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000002',
      parentId: '0000000000000004',
      functionName: 'DirectExport',
      startTime: Date.now(),
    }), true)
  })
})

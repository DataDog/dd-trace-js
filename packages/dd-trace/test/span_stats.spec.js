'use strict'

const assert = require('node:assert/strict')
const { hostname } = require('os')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')

const identityRefreshChannel = channel('datadog:identity:refresh')

const { LogCollapsingLowestDenseDDSketch } = require('../../../vendor/dist/@datadog/sketches-js')
const { version } = require('../src/pkg')
const pkg = require('../../../package.json')
const { ORIGIN_KEY, TOP_LEVEL_KEY, SVC_SRC_KEY } = require('../src/constants')

const {
  MEASURED,
  HTTP_STATUS_CODE,
  HTTP_ENDPOINT,
  HTTP_ROUTE,
  HTTP_METHOD,
  SPAN_KIND,
  GRPC_STATUS_CODE,
} = require('../../../ext/tags')
const {
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME,
} = require('../src/encode/tags-processors')
const processTags = require('../src/process-tags')
const { getConfigFresh } = require('./helpers/config')

// Mock spans use the post-format field name `start` (nanoseconds), matching
// what `SpanProcessor.process` hands to `onSpanFinished` via the formatted
// span. The formatter never emits `startTime`, so reading that field bucketed
// every span under a single NaN time key.
const basicSpan = {
  start: 12345 * 1e9,
  duration: 1234,
  error: 0,
  name: 'basic-span',
  service: 'service-name',
  resource: 'resource-name',
  type: 'span-type',
  meta: {
    [HTTP_STATUS_CODE]: 200,
    [SVC_SRC_KEY]: 'integration',
  },
  metrics: {},
}

const topLevelSpan = {
  ...basicSpan,
  name: 'top-level-span',
  metrics: {
    ...basicSpan.metrics,
    [TOP_LEVEL_KEY]: 1,
  },
}

const errorSpan = {
  ...basicSpan,
  name: 'error-span',
  error: 1,
  meta: {
    ...basicSpan.meta,
    [HTTP_STATUS_CODE]: 500,
  },
  metrics: {
    ...basicSpan.metrics,
    [MEASURED]: 1,
  },
}

const syntheticSpan = {
  ...basicSpan,
  name: 'synthetic-span',
  meta: {
    ...basicSpan.meta,
    [ORIGIN_KEY]: 'synthetics',
  },
}

const exporter = {
  export: sinon.stub(),
  flush: sinon.stub(),
  resetPendingState: sinon.stub(),
}

const SpanStatsExporter = sinon.stub().returns(exporter)

const otlpExporter = {
  export: sinon.stub(),
  flush: sinon.stub(),
}

const {
  SpanAggStats,
  SpanAggKey,
  SpanBuckets,
  TimeBuckets,
  SpanStatsProcessor,
} = proxyquire('../src/span_stats', {
  './exporters/span-stats': {
    SpanStatsExporter,
  },
})

describe('SpanAggKey', () => {
  it('should make aggregation key for a basic span', () => {
    const key = new SpanAggKey(basicSpan)
    assert.strictEqual(
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,,,integration,,')
  })

  it('should make aggregation key for a synthetic span', () => {
    const key = new SpanAggKey(syntheticSpan)
    assert.strictEqual(
      key.toString(), 'synthetic-span,service-name,resource-name,span-type,200,true,,,integration,,')
  })

  it('should make aggregation key for an error span', () => {
    const key = new SpanAggKey(errorSpan)
    assert.strictEqual(
      key.toString(), 'error-span,service-name,resource-name,span-type,500,false,,,integration,,')
  })

  it('should use sensible defaults', () => {
    const key = new SpanAggKey({ meta: {}, metrics: {} })
    assert.strictEqual(key.toString(), `${DEFAULT_SPAN_NAME},${DEFAULT_SERVICE_NAME},,,0,false,,,,,`)
    assert.strictEqual(key.isTraceRoot, undefined)
  })

  it('should include HTTP method and route in aggregation key', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [HTTP_METHOD]: 'GET',
        [HTTP_ROUTE]: '/users/:id',
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,GET,/users/:id,integration,,')
  })

  it('should include HTTP method and endpoint in aggregation key', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [HTTP_METHOD]: 'POST',
        [HTTP_ENDPOINT]: '/users/{param:int}',
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(
      key.toString(),
      'basic-span,service-name,resource-name,span-type,200,false,POST,/users/{param:int},integration,,')
  })

  it('should prioritize http.route over http.endpoint', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [HTTP_METHOD]: 'GET',
        [HTTP_ROUTE]: '/users/:id',
        [HTTP_ENDPOINT]: '/users/{param:int}',
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,GET,/users/:id,integration,,')
  })

  it('should include service source in aggregation key', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SVC_SRC_KEY]: 'opt.plugin',
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,,,opt.plugin,,')
  })

  it('should include span kind in aggregation key', () => {
    const span = { ...basicSpan, meta: { ...basicSpan.meta, [SPAN_KIND]: 'server' } }
    const key = new SpanAggKey(span)
    assert.strictEqual(
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,,,integration,server,')
  })

  it('should normalize gRPC status name to numeric string in aggregation key', () => {
    const span = { ...basicSpan, meta: { ...basicSpan.meta, [GRPC_STATUS_CODE]: 'NOT_FOUND' } }
    const key = new SpanAggKey(span)
    assert.strictEqual(
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,,,integration,,5')
  })

  it('should keep numeric gRPC status code as numeric string in aggregation key', () => {
    const span = { ...basicSpan, meta: {}, metrics: { [GRPC_STATUS_CODE]: 14 } }
    const key = new SpanAggKey(span)
    assert.strictEqual(
      key.toString(), 'basic-span,service-name,resource-name,span-type,0,false,,,,,14')
  })

  it('should defer trace-root detection until bucketing requests it', () => {
    const equals = sinon.stub().returns(false)
    const span = { ...basicSpan, parent_id: { equals } }
    const key = new SpanAggKey(span)
    sinon.assert.notCalled(equals)
    assert.strictEqual(key.isTraceRoot, undefined)
    assert.strictEqual(
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,,,integration,,')
  })

  it('should use rpc.grpc.status_code OTel alias when grpc.status.code is absent', () => {
    const span = { ...basicSpan, meta: { ...basicSpan.meta, 'rpc.grpc.status_code': '2' }, metrics: {} }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.rpcStatusCode, '2')
  })

  it('should use rpc.response.status_code OTel alias as last resort', () => {
    const meta = { ...basicSpan.meta, 'rpc.response.status_code': 'INVALID_ARGUMENT' }
    const span = { ...basicSpan, meta, metrics: {} }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.rpcStatusCode, '3')
  })
})

describe('SpanAggStats', () => {
  it('should record a basic span', () => {
    const aggKey = new SpanAggKey(basicSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(basicSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    okDistribution.accept(basicSpan.duration)

    assert.deepStrictEqual(aggStats.toJSON(), [{
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      HTTPMethod: aggKey.method,
      HTTPEndpoint: aggKey.endpoint,
      srv_src: aggKey.srvSrc,
      SpanKind: aggKey.spanKind,

      GRPCStatusCode: aggKey.rpcStatusCode,
      Hits: 1,
      TopLevelHits: 0,
      Errors: 0,
      Duration: basicSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto(),
    }])
  })

  it('should record a top-level span', () => {
    const aggKey = new SpanAggKey(topLevelSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(topLevelSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    okDistribution.accept(topLevelSpan.duration)

    assert.deepStrictEqual(aggStats.toJSON(), [{
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      HTTPMethod: aggKey.method,
      HTTPEndpoint: aggKey.endpoint,
      srv_src: aggKey.srvSrc,
      SpanKind: aggKey.spanKind,

      GRPCStatusCode: aggKey.rpcStatusCode,
      Hits: 1,
      TopLevelHits: 1,
      Errors: 0,
      Duration: topLevelSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto(),
    }])
  })

  it('should record an error span', () => {
    const aggKey = new SpanAggKey(errorSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(errorSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    errorDistribution.accept(errorSpan.duration)

    assert.deepStrictEqual(aggStats.toJSON(), [{
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      HTTPMethod: aggKey.method,
      HTTPEndpoint: aggKey.endpoint,
      srv_src: aggKey.srvSrc,
      SpanKind: aggKey.spanKind,

      GRPCStatusCode: aggKey.rpcStatusCode,
      Hits: 1,
      TopLevelHits: 0,
      Errors: 1,
      Duration: errorSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto(),
    }])
  })
})

describe('SpanBuckets', () => {
  const buckets = new SpanBuckets()

  it('should start empty', () => {
    assert.strictEqual(buckets.size, 0)
  })

  it('should add a new entry when no matching span agg key is found', () => {
    const bucket = buckets.forSpan(basicSpan)
    assert.ok(bucket instanceof SpanAggStats)
    assert.strictEqual(buckets.size, 1)
    const [key, value] = Array.from(buckets.entries())[0]
    assert.strictEqual(key, (new SpanAggKey(basicSpan)).toString())
    assert.ok(value instanceof SpanAggStats)
  })

  it('should not add a new entry if matching span agg key is found', () => {
    buckets.forSpan(basicSpan)
    assert.strictEqual(buckets.size, 1)
  })

  it('should keep top-level and non-top-level distributions separate within one aggregation bucket', () => {
    const localBuckets = new SpanBuckets()
    const topLevelBasicSpan = {
      ...basicSpan,
      metrics: { ...basicSpan.metrics, [TOP_LEVEL_KEY]: 1 },
    }

    localBuckets.forSpan(basicSpan).record(basicSpan)
    localBuckets.forSpan(topLevelBasicSpan).record(topLevelBasicSpan)

    assert.strictEqual(localBuckets.size, 1)
    const stats = localBuckets.values().next().value
    assert.strictEqual(stats.nonTopLevelOkDistribution.count, 1)
    assert.strictEqual(stats.topLevelOkDistribution.count, 1)
  })

  it('should add a new entry when new span does not match existing agg keys', () => {
    buckets.forSpan(errorSpan)
    assert.strictEqual(buckets.size, 2)
  })

  it('should split trace roots only when requested by the OTLP exporter', () => {
    const rootIdEquals = sinon.stub().returns(true)
    const childIdEquals = sinon.stub().returns(false)
    const rootSpan = { ...basicSpan, parent_id: { equals: rootIdEquals } }
    const childSpan = { ...basicSpan, parent_id: { equals: childIdEquals } }
    const legacyBuckets = new SpanBuckets()
    const otlpBuckets = new SpanBuckets(true)

    legacyBuckets.forSpan(rootSpan)
    legacyBuckets.forSpan(childSpan)
    sinon.assert.notCalled(rootIdEquals)
    sinon.assert.notCalled(childIdEquals)

    otlpBuckets.forSpan(rootSpan)
    otlpBuckets.forSpan(childSpan)

    assert.strictEqual(legacyBuckets.size, 1)
    assert.strictEqual(legacyBuckets.values().next().value.aggKey.isTraceRoot, undefined)
    assert.strictEqual(otlpBuckets.size, 2)
    assert.deepStrictEqual([...otlpBuckets.values()].map(({ aggKey }) => aggKey.isTraceRoot), [true, false])
    sinon.assert.calledOnce(rootIdEquals)
    sinon.assert.calledOnce(childIdEquals)
  })

  it('should leave trace-root unknown when parent_id is missing or null', () => {
    for (const parentId of [undefined, null]) {
      const otlpBuckets = new SpanBuckets(true)

      otlpBuckets.forSpan({ ...basicSpan, parent_id: parentId })

      assert.strictEqual(otlpBuckets.values().next().value.aggKey.isTraceRoot, undefined)
    }
  })
})

describe('TimeBuckets', () => {
  it('should acquire a span agg bucket for the given time', () => {
    const buckets = new TimeBuckets()
    assert.strictEqual(buckets.size, 0)
    const bucket = buckets.forTime(12345)
    assert.strictEqual(buckets.size, 1)
    assert.ok(bucket instanceof SpanBuckets)
  })
})

describe('SpanStatsProcessor', () => {
  let errorDistribution
  let okDistribution
  let processor
  const n = 100

  const config = {
    stats: {
      DD_TRACE_STATS_COMPUTATION_ENABLED: true,
      interval: 10,
    },
    hostname: '127.0.0.1',
    port: 8126,
    url: new URL('http://127.0.0.1:8126'),
    env: 'test',
    tags: { tag: 'some tag' },
    version: '1.0.0',
  }

  it('should construct', () => {
    processor = new SpanStatsProcessor(config)
    clearTimeout(processor.timer)

    assert.deepStrictEqual(SpanStatsExporter.lastCall.args[0], {
      hostname: config.hostname,
      port: config.port,
      url: config.url,
      tags: config.tags,
    })
    assert.strictEqual(processor.interval, config.stats.interval)
    assert.ok(processor.buckets instanceof TimeBuckets)
    assert.strictEqual(processor.hostname, hostname())
    assert.strictEqual(processor.enabled, config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED)
    assert.strictEqual(processor.env, config.env)
    assert.strictEqual(processor.version, config.version)
  })

  it('should construct a disabled instance', () => {
    const disabledConfig = { ...config, stats: { DD_TRACE_STATS_COMPUTATION_ENABLED: false, interval: 10 } }
    const processor = new SpanStatsProcessor(disabledConfig)

    assert.strictEqual(processor.enabled, false)
    assert.strictEqual(processor.timer, undefined)
  })

  it('should track span stats', () => {
    assert.strictEqual(processor.buckets.size, 0)
    for (let i = 0; i < n; i++) {
      processor.onSpanFinished(topLevelSpan)
    }
    assert.strictEqual(processor.buckets.size, 1)

    const timeBucket = processor.buckets.values().next().value
    assert.ok(timeBucket instanceof SpanBuckets)
    assert.strictEqual(timeBucket.size, 1)

    const spanBucket = timeBucket.forSpan(topLevelSpan)
    assert.strictEqual(timeBucket.size, 1)
    assert.ok(spanBucket instanceof SpanAggStats)

    okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    for (let i = 0; i < n; i++) {
      okDistribution.accept(topLevelSpan.duration)
    }

    assert.deepStrictEqual(spanBucket.toJSON(), [{
      Name: 'top-level-span',
      Service: 'service-name',
      Resource: 'resource-name',
      Type: 'span-type',
      HTTPStatusCode: 200,
      Synthetics: false,
      HTTPMethod: '',
      HTTPEndpoint: '',
      srv_src: 'integration',
      SpanKind: '',
      GRPCStatusCode: '',
      Hits: n,
      TopLevelHits: n,
      Errors: 0,
      Duration: (topLevelSpan.duration) * n,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto(),
    }])
  })

  it('should bucket by the formatted span start, not the missing startTime field', () => {
    const localProcessor = new SpanStatsProcessor(config)
    clearTimeout(localProcessor.timer)

    localProcessor.onSpanFinished(topLevelSpan)

    const bucketTime = localProcessor.buckets.keys().next().value
    assert.ok(Number.isFinite(bucketTime), `bucket time should be finite, got ${bucketTime}`)
    assert.strictEqual(bucketTime, 12340000000000)
  })

  it('should bucket spans by their containing interval boundary', () => {
    const localProcessor = new SpanStatsProcessor(config)
    clearTimeout(localProcessor.timer)

    const bucketSizeNs = config.stats.interval * 1e9
    // Last nanosecond of the first bucket and first nanosecond of the second.
    const lastInFirstBucket = { ...topLevelSpan, start: bucketSizeNs - topLevelSpan.duration - 1 }
    const firstInSecondBucket = { ...topLevelSpan, start: bucketSizeNs }

    localProcessor.onSpanFinished(lastInFirstBucket)
    localProcessor.onSpanFinished(firstInSecondBucket)

    const bucketTimes = [...localProcessor.buckets.keys()]
    assert.deepStrictEqual(bucketTimes, [0, bucketSizeNs])
  })

  it('should export on interval', () => {
    processor.onInterval()

    assert.deepStrictEqual(exporter.export.lastCall.args[0], {
      Hostname: hostname(),
      Env: config.env,
      Version: config.version,
      Stats: [{
        Start: 12340000000000,
        Duration: 10000000000,
        Stats: [{
          Name: 'top-level-span',
          Service: 'service-name',
          Resource: 'resource-name',
          Type: 'span-type',
          HTTPStatusCode: 200,
          Synthetics: false,
          HTTPMethod: '',
          HTTPEndpoint: '',
          srv_src: 'integration',
          SpanKind: '',
          GRPCStatusCode: '',
          Hits: n,
          TopLevelHits: n,
          Errors: 0,
          Duration: (topLevelSpan.duration) * n,
          OkSummary: okDistribution.toProto(),
          ErrorSummary: errorDistribution.toProto(),
        }],
      }],
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: config.tags['runtime-id'],
      Sequence: processor.sequence,
      ProcessTags: processTags.serialized,
    })
  })

  it('should export the current runtime ID after remote config replaces tags', () => {
    const config = getConfigFresh({ stats: true })
    const processor = new SpanStatsProcessor(config)
    clearTimeout(processor.timer)
    const originalTags = config.tags
    const originalRuntimeId = originalTags['runtime-id']

    processor.onInterval()
    assert.strictEqual(exporter.export.lastCall.args[0].RuntimeID, originalRuntimeId)

    config.setRemoteConfig({ tags: { team: 'backend' } })
    assert.notStrictEqual(config.tags, originalTags)
    channel('datadog:identity:update').publish(config)
    processor.onInterval()

    assert.notStrictEqual(config.tags['runtime-id'], originalRuntimeId)
    assert.strictEqual(exporter.export.lastCall.args[0].RuntimeID, config.tags['runtime-id'])
  })

  it('should export on interval with default version', () => {
    const versionlessConfig = { ...config }
    delete versionlessConfig.version
    const processor = new SpanStatsProcessor(versionlessConfig)
    processor.onInterval()

    assert.deepStrictEqual(exporter.export.lastCall.args[0], {
      Hostname: hostname(),
      Env: config.env,
      Version: version,
      Stats: [],
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: versionlessConfig.tags['runtime-id'],
      Sequence: processor.sequence,
      ProcessTags: processTags.serialized,
    })
  })

  it('should clear buckets after each interval flush', () => {
    const p = new SpanStatsProcessor(config)
    clearTimeout(p.timer)
    p.onSpanFinished(topLevelSpan)

    assert.strictEqual(p.buckets.size, 1)
    p.onInterval()
    assert.strictEqual(p.buckets.size, 0)
  })

  it('creates and stores the injected otlp exporter', () => {
    const p = new SpanStatsProcessor(config, otlpExporter)
    clearTimeout(p.timer)
    assert.strictEqual(p.otlpExporter, otlpExporter)
  })

  it('should call OTLP exporter on interval when traceMetrics enabled', () => {
    otlpExporter.export.resetHistory()
    const p = new SpanStatsProcessor(config, otlpExporter)
    clearTimeout(p.timer)
    p.onSpanFinished(topLevelSpan)
    p.onInterval()

    assert.ok(otlpExporter.export.calledOnce)
    const [drained, bucketSizeNs] = otlpExporter.export.firstCall.args
    assert.strictEqual(drained.length, 1)
    assert.strictEqual(bucketSizeNs, p.bucketSizeNs)
  })

  it('should split OTLP trace roots when their attribute is exported', () => {
    const childSpan = { ...topLevelSpan, parent_id: { equals: () => false } }
    const processor = new SpanStatsProcessor(config, otlpExporter)
    clearTimeout(processor.timer)

    processor.onSpanFinished(topLevelSpan)
    processor.onSpanFinished(childSpan)

    assert.strictEqual(processor.buckets.values().next().value.size, 2)
  })

  it('should not call OTLP exporter on interval when drained is empty', () => {
    otlpExporter.export.resetHistory()
    const p = new SpanStatsProcessor(config, otlpExporter)
    clearTimeout(p.timer)
    p.onInterval()

    assert.ok(otlpExporter.export.notCalled)
  })

  it('should not call the legacy /v0.6/stats exporter when OTLP is enabled (mutual exclusion)', () => {
    exporter.export.resetHistory()
    otlpExporter.export.resetHistory()
    const p = new SpanStatsProcessor(config, otlpExporter)
    clearTimeout(p.timer)
    p.onSpanFinished(topLevelSpan)
    p.onInterval()

    assert.ok(exporter.export.notCalled)
    assert.ok(otlpExporter.export.calledOnce)
  })

  it('force flushes pending OTLP span statistics', () => {
    const exporter = {
      export: sinon.stub().callsFake((_drained, _bucketSizeNs, done) => done()),
      flush: sinon.stub().callsFake(done => done()),
    }
    const p = new SpanStatsProcessor(config, exporter)
    clearTimeout(p.timer)
    p.onSpanFinished(topLevelSpan)

    let flushed = false
    p.forceFlush(() => { flushed = true })

    assert.ok(exporter.export.calledOnce)
    assert.ok(exporter.flush.calledOnce)
    assert.ok(flushed)
    assert.strictEqual(p.buckets.size, 0)
  })

  it('snapshots prior OTLP exports before starting the boundary export', () => {
    let priorDone
    let exportDone
    const exporter = {
      flush: sinon.stub().callsFake(done => { priorDone = done }),
      export: sinon.stub().callsFake((_drained, _bucketSizeNs, done) => { exportDone = done }),
    }
    const p = new SpanStatsProcessor(config, exporter)
    clearTimeout(p.timer)
    p.onSpanFinished(topLevelSpan)
    const done = sinon.spy()

    p.forceFlush(done)

    sinon.assert.callOrder(exporter.flush, exporter.export)
    exportDone()
    sinon.assert.notCalled(done)
    priorDone()
    sinon.assert.calledOnce(done)
  })

  it('waits for a prior OTLP export when the boundary export throws', () => {
    let priorDone
    const exporter = {
      flush: sinon.stub().callsFake(done => { priorDone = done }),
      export: sinon.stub().throws(new Error('encode failed')),
    }
    const p = new SpanStatsProcessor(config, exporter)
    clearTimeout(p.timer)
    p.onSpanFinished(topLevelSpan)
    const done = sinon.spy()

    p.forceFlush(done)

    sinon.assert.notCalled(done)
    priorDone()
    sinon.assert.calledOnce(done)
  })

  it('force flushes pending agent span statistics', () => {
    exporter.export.resetHistory()
    exporter.flush.resetHistory()
    exporter.export.callsFake((_payload, done) => done())
    const p = new SpanStatsProcessor(config)
    clearTimeout(p.timer)
    p.onSpanFinished(topLevelSpan)

    let flushed = false
    p.forceFlush(() => { flushed = true })

    assert.ok(exporter.export.calledOnce)
    assert.ok(exporter.flush.notCalled)
    assert.ok(flushed)
    assert.strictEqual(p.buckets.size, 0)
    exporter.export.resetBehavior()
  })

  it('joins an in-flight agent span statistics export during force flush', () => {
    exporter.export.resetHistory()
    exporter.flush.resetHistory()
    const p = new SpanStatsProcessor(config)
    clearTimeout(p.timer)
    p.onSpanFinished(topLevelSpan)

    let flushDone
    exporter.export.callsFake((_payload, done) => { flushDone = done })
    let flushed = false
    p.forceFlush(() => { flushed = true })

    assert.ok(exporter.export.calledOnce)
    assert.ok(exporter.flush.notCalled)
    assert.strictEqual(flushed, false)
    flushDone()
    assert.strictEqual(flushed, true)
    exporter.export.resetBehavior()
  })

  it('should record spans when only OTLP is enabled', () => {
    otlpExporter.export.resetHistory()
    const p = new SpanStatsProcessor({
      stats: { DD_TRACE_STATS_COMPUTATION_ENABLED: false, interval: 10 },
      hostname: '127.0.0.1',
      port: 8126,
      url: new URL('http://127.0.0.1:8126'),
      env: 'test',
      tags: {},
    }, otlpExporter)
    clearTimeout(p.timer)

    p.onSpanFinished(topLevelSpan)
    assert.strictEqual(p.buckets.size, 1)
  })

  it('should clear pending buckets when the identity-refresh channel fires', () => {
    exporter.resetPendingState.resetHistory()
    const p = new SpanStatsProcessor(config)
    clearTimeout(p.timer)

    p.onSpanFinished(topLevelSpan)
    assert.strictEqual(p.buckets.size, 1)

    const previousBuckets = p.buckets
    identityRefreshChannel.publish(config)

    assert.notStrictEqual(p.buckets, previousBuckets)
    assert.strictEqual(p.buckets.size, 0)
    sinon.assert.calledOnce(exporter.resetPendingState)
  })

  it('should preserve OTLP trace-root splitting after an identity refresh', () => {
    const childSpan = { ...topLevelSpan, parent_id: { equals: () => false } }
    const p = new SpanStatsProcessor(config, otlpExporter)
    clearTimeout(p.timer)

    identityRefreshChannel.publish(config)

    p.onSpanFinished(topLevelSpan)
    p.onSpanFinished(childSpan)

    assert.strictEqual(p.buckets.values().next().value.size, 2)
  })

  it('should stop reacting to identity refresh once a newer instance takes over', () => {
    const first = new SpanStatsProcessor(config)
    clearTimeout(first.timer)
    const firstBuckets = first.buckets

    const second = new SpanStatsProcessor(config)
    clearTimeout(second.timer)
    const secondBuckets = second.buckets

    identityRefreshChannel.publish(config)

    // Only the second (newest) instance should react - the first's subscription was replaced,
    // not stacked on top of.
    assert.strictEqual(first.buckets, firstBuckets)
    assert.notStrictEqual(second.buckets, secondBuckets)
  })
})

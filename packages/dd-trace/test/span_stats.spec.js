'use strict'

const assert = require('node:assert/strict')
const { hostname } = require('os')

const { describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')
const { LogCollapsingLowestDenseDDSketch } = require('../../../vendor/dist/@datadog/sketches-js')
const { version } = require('../src/pkg')
const pkg = require('../../../package.json')
const { ORIGIN_KEY, TOP_LEVEL_KEY } = require('../src/constants')

const {
  MEASURED,
  HTTP_STATUS_CODE,
  HTTP_ENDPOINT,
  HTTP_ROUTE,
  HTTP_METHOD,
} = require('../../../ext/tags')
const {
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME,
} = require('../src/encode/tags-processors')
const processTags = require('../src/process-tags')

// Mock spans
const basicSpan = {
  startTime: 12345 * 1e9,
  duration: 1234,
  error: 0,
  name: 'basic-span',
  service: 'service-name',
  resource: 'resource-name',
  type: 'span-type',
  meta: {
    [HTTP_STATUS_CODE]: 200,
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
}

const SpanStatsExporter = sinon.stub().returns(exporter)

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
    assert.strictEqual(key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,,')
  })

  it('should make aggregation key for a synthetic span', () => {
    const key = new SpanAggKey(syntheticSpan)
    assert.strictEqual(key.toString(), 'synthetic-span,service-name,resource-name,span-type,200,true,,')
  })

  it('should make aggregation key for an error span', () => {
    const key = new SpanAggKey(errorSpan)
    assert.strictEqual(key.toString(), 'error-span,service-name,resource-name,span-type,500,false,,')
  })

  it('should use sensible defaults', () => {
    const key = new SpanAggKey({ meta: {}, metrics: {} })
    assert.strictEqual(key.toString(), `${DEFAULT_SPAN_NAME},${DEFAULT_SERVICE_NAME},,,0,false,,`)
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
    assert.strictEqual(key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,GET,/users/:id')
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
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,POST,/users/{param:int}')
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
    assert.strictEqual(key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,GET,/users/:id')
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

    assert.deepStrictEqual(aggStats.toJSON(), {
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      HTTPMethod: aggKey.method,
      HTTPEndpoint: aggKey.endpoint,
      Hits: 1,
      TopLevelHits: 0,
      Errors: 0,
      Duration: basicSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto(),
    })
  })

  it('should record a top-level span', () => {
    const aggKey = new SpanAggKey(topLevelSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(topLevelSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    okDistribution.accept(topLevelSpan.duration)

    assert.deepStrictEqual(aggStats.toJSON(), {
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      HTTPMethod: aggKey.method,
      HTTPEndpoint: aggKey.endpoint,
      Hits: 1,
      TopLevelHits: 1,
      Errors: 0,
      Duration: topLevelSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto(),
    })
  })

  it('should record an error span', () => {
    const aggKey = new SpanAggKey(errorSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(errorSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    errorDistribution.accept(errorSpan.duration)

    assert.deepStrictEqual(aggStats.toJSON(), {
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      HTTPMethod: aggKey.method,
      HTTPEndpoint: aggKey.endpoint,
      Hits: 1,
      TopLevelHits: 0,
      Errors: 1,
      Duration: errorSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto(),
    })
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

  it('should add a new entry when new span does not match existing agg keys', () => {
    buckets.forSpan(errorSpan)
    assert.strictEqual(buckets.size, 2)
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
      enabled: true,
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

    assert.ok(SpanStatsExporter.calledWith({
      hostname: config.hostname,
      port: config.port,
      url: config.url,
      tags: config.tags,
    }))
    assert.strictEqual(processor.interval, config.stats.interval)
    assert.ok(processor.buckets instanceof TimeBuckets)
    assert.strictEqual(processor.hostname, hostname())
    assert.strictEqual(processor.enabled, config.stats.enabled)
    assert.strictEqual(processor.env, config.env)
    assert.deepStrictEqual(processor.tags, config.tags)
    assert.strictEqual(processor.version, config.version)
  })

  it('should construct a disabled instance', () => {
    const disabledConfig = { ...config, stats: { enabled: false, interval: 10 } }
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

    assert.deepStrictEqual(spanBucket.toJSON(), {
      Name: 'top-level-span',
      Service: 'service-name',
      Resource: 'resource-name',
      Type: 'span-type',
      HTTPStatusCode: 200,
      Synthetics: false,
      HTTPMethod: '',
      HTTPEndpoint: '',
      Hits: n,
      TopLevelHits: n,
      Errors: 0,
      Duration: (topLevelSpan.duration) * n,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto(),
    })
  })

  it('should export on interval', () => {
    processor.onInterval()

    assert.ok(exporter.export.calledWith({
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
      RuntimeID: processor.tags['runtime-id'],
      Sequence: processor.sequence,
      ProcessTags: processTags.serialized,
    }))
  })

  it('should export on interval with default version', () => {
    const versionlessConfig = { ...config }
    delete versionlessConfig.version
    const processor = new SpanStatsProcessor(versionlessConfig)
    processor.onInterval()

    assert.ok(exporter.export.calledWith({
      Hostname: hostname(),
      Env: config.env,
      Version: version,
      Stats: [],
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: processor.tags['runtime-id'],
      Sequence: processor.sequence,
      ProcessTags: processTags.serialized,
    }))
  })
})

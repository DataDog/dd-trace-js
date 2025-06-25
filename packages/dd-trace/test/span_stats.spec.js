'use strict'

const t = require('tap')
require('./setup/core')

const { hostname } = require('os')

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

const { version } = require('../src/pkg')
const pkg = require('../../../package.json')
const { ORIGIN_KEY, TOP_LEVEL_KEY } = require('../src/constants')
const {
  MEASURED,
  HTTP_STATUS_CODE
} = require('../../../ext/tags')
const {
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME
} = require('../src/encode/tags-processors')

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
    [HTTP_STATUS_CODE]: 200
  },
  metrics: {}
}

const topLevelSpan = {
  ...basicSpan,
  name: 'top-level-span',
  metrics: {
    ...basicSpan.metrics,
    [TOP_LEVEL_KEY]: 1
  }
}

const errorSpan = {
  ...basicSpan,
  name: 'error-span',
  error: 1,
  meta: {
    ...basicSpan.meta,
    [HTTP_STATUS_CODE]: 500
  },
  metrics: {
    ...basicSpan.metrics,
    [MEASURED]: 1
  }
}

const syntheticSpan = {
  ...basicSpan,
  name: 'synthetic-span',
  meta: {
    ...basicSpan.meta,
    [ORIGIN_KEY]: 'synthetics'
  }
}

const exporter = {
  export: sinon.stub()
}

const SpanStatsExporter = sinon.stub().returns(exporter)

const {
  SpanAggStats,
  SpanAggKey,
  SpanBuckets,
  TimeBuckets,
  SpanStatsProcessor
} = proxyquire('../src/span_stats', {
  './exporters/span-stats': {
    SpanStatsExporter
  }
})

t.test('SpanAggKey', t => {
  t.test('should make aggregation key for a basic span', t => {
    const key = new SpanAggKey(basicSpan)
    expect(key.toString()).to.equal('basic-span,service-name,resource-name,span-type,200,false')
    t.end()
  })

  t.test('should make aggregation key for a synthetic span', t => {
    const key = new SpanAggKey(syntheticSpan)
    expect(key.toString()).to.equal('synthetic-span,service-name,resource-name,span-type,200,true')
    t.end()
  })

  t.test('should make aggregation key for an error span', t => {
    const key = new SpanAggKey(errorSpan)
    expect(key.toString()).to.equal('error-span,service-name,resource-name,span-type,500,false')
    t.end()
  })

  t.test('should use sensible defaults', t => {
    const key = new SpanAggKey({ meta: {}, metrics: {} })
    expect(key.toString()).to.equal(`${DEFAULT_SPAN_NAME},${DEFAULT_SERVICE_NAME},,,0,false`)
    t.end()
  })
  t.end()
})

t.test('SpanAggStats', t => {
  t.test('should record a basic span', t => {
    const aggKey = new SpanAggKey(basicSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(basicSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    okDistribution.accept(basicSpan.duration)

    expect(aggStats.toJSON()).to.deep.equal({
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      Hits: 1,
      TopLevelHits: 0,
      Errors: 0,
      Duration: basicSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto()
    })
    t.end()
  })

  t.test('should record a top-level span', t => {
    const aggKey = new SpanAggKey(topLevelSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(topLevelSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    okDistribution.accept(topLevelSpan.duration)

    expect(aggStats.toJSON()).to.deep.equal({
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      Hits: 1,
      TopLevelHits: 1,
      Errors: 0,
      Duration: topLevelSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto()
    })
    t.end()
  })

  t.test('should record an error span', t => {
    const aggKey = new SpanAggKey(errorSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(errorSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    errorDistribution.accept(errorSpan.duration)

    expect(aggStats.toJSON()).to.deep.equal({
      Name: aggKey.name,
      Type: aggKey.type,
      Resource: aggKey.resource,
      Service: aggKey.service,
      HTTPStatusCode: aggKey.statusCode,
      Synthetics: aggKey.synthetics,
      Hits: 1,
      TopLevelHits: 0,
      Errors: 1,
      Duration: errorSpan.duration,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto()
    })
    t.end()
  })
  t.end()
})

t.test('SpanBuckets', t => {
  const buckets = new SpanBuckets()

  t.test('should start empty', t => {
    expect(buckets.size).to.equal(0)
    t.end()
  })

  t.test('should add a new entry when no matching span agg key is found', t => {
    const bucket = buckets.forSpan(basicSpan)
    expect(bucket).to.be.an.instanceOf(SpanAggStats)
    expect(buckets.size).to.equal(1)
    const [key, value] = Array.from(buckets.entries())[0]
    expect(key).to.equal((new SpanAggKey(basicSpan)).toString())
    expect(value).to.be.instanceOf(SpanAggStats)
    t.end()
  })

  t.test('should not add a new entry if matching span agg key is found', t => {
    buckets.forSpan(basicSpan)
    expect(buckets.size).to.equal(1)
    t.end()
  })

  t.test('should add a new entry when new span does not match existing agg keys', t => {
    buckets.forSpan(errorSpan)
    expect(buckets.size).to.equal(2)
    t.end()
  })
  t.end()
})

t.test('TimeBuckets', t => {
  t.test('should acquire a span agg bucket for the given time', t => {
    const buckets = new TimeBuckets()
    expect(buckets.size).to.equal(0)
    const bucket = buckets.forTime(12345)
    expect(buckets.size).to.equal(1)
    expect(bucket).to.be.an.instanceOf(SpanBuckets)
    t.end()
  })
  t.end()
})

t.test('SpanStatsProcessor', t => {
  let errorDistribution
  let okDistribution
  let processor
  const n = 100

  const config = {
    stats: {
      enabled: true,
      interval: 10
    },
    hostname: '127.0.0.1',
    port: 8126,
    url: new URL('http://127.0.0.1:8126'),
    env: 'test',
    tags: { tag: 'some tag' },
    version: '1.0.0'
  }

  t.test('should construct', t => {
    processor = new SpanStatsProcessor(config)
    clearTimeout(processor.timer)

    expect(SpanStatsExporter).to.be.calledWith({
      hostname: config.hostname,
      port: config.port,
      url: config.url,
      tags: config.tags
    })
    expect(processor.interval).to.equal(config.stats.interval)
    expect(processor.buckets).to.be.instanceOf(TimeBuckets)
    expect(processor.hostname).to.equal(hostname())
    expect(processor.enabled).to.equal(config.stats.enabled)
    expect(processor.env).to.equal(config.env)
    expect(processor.tags).to.deep.equal(config.tags)
    expect(processor.version).to.equal(config.version)
    t.end()
  })

  t.test('should construct a disabled instance', t => {
    const disabledConfig = { ...config, stats: { enabled: false, interval: 10 } }
    const processor = new SpanStatsProcessor(disabledConfig)

    expect(processor.enabled).to.be.false
    expect(processor.timer).to.be.undefined
    t.end()
  })

  t.test('should track span stats', t => {
    expect(processor.buckets.size).to.equal(0)
    for (let i = 0; i < n; i++) {
      processor.onSpanFinished(topLevelSpan)
    }
    expect(processor.buckets.size).to.equal(1)

    const timeBucket = processor.buckets.values().next().value
    expect(timeBucket).to.be.instanceOf(SpanBuckets)
    expect(timeBucket.size).to.equal(1)

    const spanBucket = timeBucket.forSpan(topLevelSpan)
    expect(timeBucket.size).to.equal(1)
    expect(spanBucket).to.be.instanceOf(SpanAggStats)

    okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    for (let i = 0; i < n; i++) {
      okDistribution.accept(topLevelSpan.duration)
    }

    expect(spanBucket.toJSON()).to.deep.equal({
      Name: 'top-level-span',
      Service: 'service-name',
      Resource: 'resource-name',
      Type: 'span-type',
      HTTPStatusCode: 200,
      Synthetics: false,
      Hits: n,
      TopLevelHits: n,
      Errors: 0,
      Duration: (topLevelSpan.duration) * n,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto()
    })
    t.end()
  })

  t.test('should export on interval', t => {
    processor.onInterval()

    expect(exporter.export).to.be.calledWith({
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
          Hits: n,
          TopLevelHits: n,
          Errors: 0,
          Duration: (topLevelSpan.duration) * n,
          OkSummary: okDistribution.toProto(),
          ErrorSummary: errorDistribution.toProto()
        }]
      }],
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: processor.tags['runtime-id'],
      Sequence: processor.sequence
    })
    t.end()
  })

  t.test('should export on interval with default version', t => {
    const versionlessConfig = { ...config }
    delete versionlessConfig.version
    const processor = new SpanStatsProcessor(versionlessConfig)
    processor.onInterval()

    expect(exporter.export).to.be.calledWith({
      Hostname: hostname(),
      Env: config.env,
      Version: version,
      Stats: [],
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: processor.tags['runtime-id'],
      Sequence: processor.sequence
    })
    t.end()
  })
  t.end()
})

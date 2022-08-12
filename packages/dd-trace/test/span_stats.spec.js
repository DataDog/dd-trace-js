'use strict'

const { hostname } = require('os')

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

const { version } = require('../src/pkg')
const pkg = require('../../../package.json')
const { ERROR } = require('../../../ext/tags')
const { ORIGIN_KEY, TOP_LEVEL_KEY } = require('../src/constants')
const {
  MEASURED,
  HTTP_STATUS_CODE,
  SPAN_TYPE,
  RESOURCE_NAME,
  SERVICE_NAME
} = require('../../../ext/tags')
const {
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME
} = require('../src/encode/tags-processors')

// Mock spans
const basicSpan = {
  _startTime: 14 * 1e9,
  _duration: 1234,
  error: false,
  _spanContext: {
    _name: 'basic-span',
    _tags: {
      [MEASURED]: 0,
      [HTTP_STATUS_CODE]: 200,
      [SPAN_TYPE]: 'span-type',
      [RESOURCE_NAME]: 'resource-name',
      [SERVICE_NAME]: 'service-name'
    }
  }
}

const topLevelSpan = {
  ...basicSpan,
  _spanContext: {
    _name: 'top-level-span',
    _tags: {
      ...basicSpan._spanContext._tags,
      [TOP_LEVEL_KEY]: 1
    }
  }
}

const errorSpan = {
  ...basicSpan,
  _spanContext: {
    _name: 'error-span',
    _tags: {
      ...basicSpan._spanContext._tags,
      [HTTP_STATUS_CODE]: 500,
      [MEASURED]: 1,
      [ERROR]: true
    }
  }
}

const syntheticSpan = {
  ...basicSpan,
  _spanContext: {
    _name: 'synthetic-span',
    _tags: {
      ...basicSpan._spanContext._tags,
      [ORIGIN_KEY]: 'synthetics'
    }
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

describe('SpanAggKey', () => {
  it('should make aggregation key for a basic span', () => {
    const key = new SpanAggKey(basicSpan)
    expect(key.toString()).to.equal('basic-span,service-name,resource-name,span-type,200,false')
  })

  it('should make aggregation key for a synthetic span', () => {
    const key = new SpanAggKey(syntheticSpan)
    expect(key.toString()).to.equal('synthetic-span,service-name,resource-name,span-type,200,true')
  })

  it('should make aggregation key for an error span', () => {
    const key = new SpanAggKey(errorSpan)
    expect(key.toString()).to.equal('error-span,service-name,resource-name,span-type,500,false')
  })

  it('should use sensible defaults', () => {
    const key = new SpanAggKey({})
    expect(key.toString()).to.equal(`${DEFAULT_SPAN_NAME},${DEFAULT_SERVICE_NAME},,,0,false`)
  })
})

describe('SpanAggStats', () => {
  it('should record a basic span', () => {
    const aggKey = new SpanAggKey(basicSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(basicSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    okDistribution.accept(basicSpan._duration * 1e6)

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
      Duration: basicSpan._duration * 1e6,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto()
    })
  })

  it('should record a top-level span', () => {
    const aggKey = new SpanAggKey(topLevelSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(topLevelSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    okDistribution.accept(topLevelSpan._duration * 1e6)

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
      Duration: topLevelSpan._duration * 1e6,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto()
    })
  })

  it('should record an error span', () => {
    const aggKey = new SpanAggKey(errorSpan)
    const aggStats = new SpanAggStats(aggKey)
    aggStats.record(errorSpan)

    const okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    const errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    errorDistribution.accept(errorSpan._duration * 1e6)

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
      Duration: errorSpan._duration * 1e6,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto()
    })
  })
})

describe('SpanBuckets', () => {
  const buckets = new SpanBuckets()

  it('should start empty', () => {
    expect(buckets.size).to.equal(0)
  })

  it('should add a new entry when no matching span agg key is found', () => {
    const bucket = buckets.forSpan(basicSpan)
    expect(bucket).to.be.an.instanceOf(SpanAggStats)
    expect(buckets.size).to.equal(1)
    const [key, value] = Array.from(buckets.entries())[0]
    expect(key).to.equal((new SpanAggKey(basicSpan)).toString())
    expect(value).to.be.instanceOf(SpanAggStats)
  })

  it('should not add a new entry if matching span agg key is found', () => {
    buckets.forSpan(basicSpan)
    expect(buckets.size).to.equal(1)
  })

  it('should add a new entry when new span does not match existing agg keys', () => {
    buckets.forSpan(errorSpan)
    expect(buckets.size).to.equal(2)
  })
})

describe('TimeBuckets', () => {
  it('should acquire a span agg bucket for the given time', () => {
    const buckets = new TimeBuckets()
    expect(buckets.size).to.equal(0)
    const bucket = buckets.forTime(12345)
    expect(buckets.size).to.equal(1)
    expect(bucket).to.be.an.instanceOf(SpanBuckets)
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
      interval: 10
    },
    hostname: '127.0.0.1',
    port: 8126,
    url: new URL('http://127.0.0.1:8126'),
    env: 'test',
    tags: { tag: 'some tag' }
  }

  it('should construct', () => {
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
  })

  it('should track span stats', () => {
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
      okDistribution.accept(topLevelSpan._duration * 1e6)
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
      Duration: (topLevelSpan._duration * 1e6) * n,
      OkSummary: okDistribution.toProto(),
      ErrorSummary: errorDistribution.toProto()
    })
  })

  it('should export on interval', () => {
    processor.onInterval()

    expect(exporter.export).to.be.calledWith({
      Hostname: hostname(),
      Env: config.env,
      Version: version,
      Stats: [{
        Start: 14000000000000000,
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
          Duration: (topLevelSpan._duration * 1e6) * n,
          OkSummary: okDistribution.toProto(),
          ErrorSummary: errorDistribution.toProto()
        }]
      }],
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: processor.tags['runtime-id'],
      Sequence: processor.sequence
    })
  })
})

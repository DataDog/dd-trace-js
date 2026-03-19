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
  SPAN_KIND,
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
  parent_id: '0',
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
  DEFAULT_PEER_TAGS,
  TRILEAN_TRUE,
  TRILEAN_FALSE,
} = proxyquire('../src/span_stats', {
  './exporters/span-stats': {
    SpanStatsExporter,
  },
})

describe('SpanAggKey', () => {
  it('should make aggregation key for a basic span', () => {
    const key = new SpanAggKey(basicSpan)
    assert.strictEqual(key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,,,,1,,0')
  })

  it('should make aggregation key for a synthetic span', () => {
    const key = new SpanAggKey(syntheticSpan)
    assert.strictEqual(key.toString(), 'synthetic-span,service-name,resource-name,span-type,200,true,,,,1,,0')
  })

  it('should make aggregation key for an error span', () => {
    const key = new SpanAggKey(errorSpan)
    assert.strictEqual(key.toString(), 'error-span,service-name,resource-name,span-type,500,false,,,,1,,0')
  })

  it('should use sensible defaults', () => {
    const key = new SpanAggKey({ meta: {}, metrics: {} })
    assert.strictEqual(key.toString(), `${DEFAULT_SPAN_NAME},${DEFAULT_SERVICE_NAME},,,0,false,,,,1,,0`)
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
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,GET,/users/:id,,1,,0')
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
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,POST,/users/{param:int},,1,,0')
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
      key.toString(), 'basic-span,service-name,resource-name,span-type,200,false,GET,/users/:id,,1,,0')
  })

  it('should include span.kind in aggregation key', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'server',
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.spanKind, 'server')
    assert.ok(key.toString().includes(',server,'))
  })

  it('should set isTraceRoot to TRUE when parent_id is 0', () => {
    const span = {
      ...basicSpan,
      parent_id: '0',
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.isTraceRoot, TRILEAN_TRUE)
  })

  it('should set isTraceRoot to FALSE when parent_id is non-zero', () => {
    const span = {
      ...basicSpan,
      parent_id: '12345',
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.isTraceRoot, TRILEAN_FALSE)
  })

  it('should set isTraceRoot to TRUE when parent_id is undefined', () => {
    const key = new SpanAggKey(basicSpan)
    assert.strictEqual(key.isTraceRoot, TRILEAN_TRUE)
  })

  it('should extract gRPC status code from rpc.grpc.status_code', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        'rpc.grpc.status_code': '2',
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.grpcStatusCode, 2)
  })

  it('should extract gRPC status code from grpc.code as fallback', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        'grpc.code': '13',
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.grpcStatusCode, 13)
  })

  it('should prioritize rpc.grpc.status_code over grpc.code', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        'rpc.grpc.status_code': '5',
        'grpc.code': '13',
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.grpcStatusCode, 5)
  })

  it('should extract gRPC status code from metrics', () => {
    const span = {
      ...basicSpan,
      metrics: {
        ...basicSpan.metrics,
        'rpc.grpc.status_code': 7,
      },
    }
    const key = new SpanAggKey(span)
    assert.strictEqual(key.grpcStatusCode, 7)
  })

  it('should return 0 for gRPC status code when none found', () => {
    const key = new SpanAggKey(basicSpan)
    assert.strictEqual(key.grpcStatusCode, 0)
  })

  it('should extract peer tags for client span kind', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'client',
        'peer.service': 'my-db',
        'db.system': 'postgresql',
      },
    }
    const key = new SpanAggKey(span, DEFAULT_PEER_TAGS)
    assert.deepStrictEqual(key.peerTags, ['db.system:postgresql', 'peer.service:my-db'])
  })

  it('should extract peer tags for producer span kind', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'producer',
        'peer.service': 'kafka-broker',
      },
    }
    const key = new SpanAggKey(span, DEFAULT_PEER_TAGS)
    assert.deepStrictEqual(key.peerTags, ['peer.service:kafka-broker'])
  })

  it('should extract peer tags for consumer span kind', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'consumer',
        'network.destination.name': 'broker.local',
      },
    }
    const key = new SpanAggKey(span, DEFAULT_PEER_TAGS)
    assert.deepStrictEqual(key.peerTags, ['network.destination.name:broker.local'])
  })

  it('should not extract peer tags for server span kind', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'server',
        'peer.service': 'my-db',
      },
    }
    const key = new SpanAggKey(span, DEFAULT_PEER_TAGS)
    assert.deepStrictEqual(key.peerTags, [])
  })

  it('should not extract peer tags when no span kind', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        'peer.service': 'my-db',
      },
    }
    const key = new SpanAggKey(span, DEFAULT_PEER_TAGS)
    assert.deepStrictEqual(key.peerTags, [])
  })

  it('should sort peer tags alphabetically', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'client',
        'peer.service': 'my-db',
        'db.system': 'postgresql',
        'out.host': 'db.example.com',
      },
    }
    const key = new SpanAggKey(span, DEFAULT_PEER_TAGS)
    assert.deepStrictEqual(key.peerTags, ['db.system:postgresql', 'out.host:db.example.com', 'peer.service:my-db'])
  })

  it('should extract peer tags for internal span kind with _dd.base_service', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'internal',
        '_dd.base_service': 'other-service',
        'peer.service': 'my-db',
      },
    }
    const key = new SpanAggKey(span, DEFAULT_PEER_TAGS)
    assert.deepStrictEqual(key.peerTags, ['_dd.base_service:other-service', 'peer.service:my-db'])
  })

  it('should not extract peer tags for internal span kind without _dd.base_service', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'internal',
        'peer.service': 'my-db',
      },
    }
    const key = new SpanAggKey(span, DEFAULT_PEER_TAGS)
    assert.deepStrictEqual(key.peerTags, [])
  })

  it('should use custom peer tag keys when provided', () => {
    const span = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'client',
        'custom.tag': 'value',
        'peer.service': 'my-db',
      },
    }
    const key = new SpanAggKey(span, ['custom.tag'])
    assert.deepStrictEqual(key.peerTags, ['custom.tag:value'])
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
      SpanKind: aggKey.spanKind,
      IsTraceRoot: aggKey.isTraceRoot,
      PeerTags: aggKey.peerTags,
      GRPCStatusCode: aggKey.grpcStatusCode,
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
      SpanKind: aggKey.spanKind,
      IsTraceRoot: aggKey.isTraceRoot,
      PeerTags: aggKey.peerTags,
      GRPCStatusCode: aggKey.grpcStatusCode,
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
      SpanKind: aggKey.spanKind,
      IsTraceRoot: aggKey.isTraceRoot,
      PeerTags: aggKey.peerTags,
      GRPCStatusCode: aggKey.grpcStatusCode,
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

    assert.deepStrictEqual(SpanStatsExporter.lastCall.args[0], {
      hostname: config.hostname,
      port: config.port,
      url: config.url,
      tags: config.tags,
    })
    assert.strictEqual(processor.interval, config.stats.interval)
    assert.ok(processor.buckets instanceof TimeBuckets)
    assert.strictEqual(processor.hostname, hostname())
    assert.strictEqual(processor.enabled, config.stats.enabled)
    assert.strictEqual(processor.env, config.env)
    assert.deepStrictEqual(processor.tags, config.tags)
    assert.strictEqual(processor.version, config.version)
    assert.deepStrictEqual(processor.peerTagKeys, DEFAULT_PEER_TAGS)
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
      SpanKind: '',
      IsTraceRoot: TRILEAN_TRUE,
      PeerTags: [],
      GRPCStatusCode: 0,
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
          SpanKind: '',
          IsTraceRoot: TRILEAN_TRUE,
          PeerTags: [],
          GRPCStatusCode: 0,
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
    })
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
      RuntimeID: processor.tags['runtime-id'],
      Sequence: processor.sequence,
      ProcessTags: processTags.serialized,
    })
  })

  it('should accept spans eligible by span.kind (server)', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    const serverSpan = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'server',
      },
      metrics: {},
    }
    proc.onSpanFinished(serverSpan)
    assert.strictEqual(proc.buckets.size, 1)
  })

  it('should accept spans eligible by span.kind (client)', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    const clientSpan = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'client',
      },
      metrics: {},
    }
    proc.onSpanFinished(clientSpan)
    assert.strictEqual(proc.buckets.size, 1)
  })

  it('should accept spans eligible by span.kind (producer)', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    const producerSpan = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'producer',
      },
      metrics: {},
    }
    proc.onSpanFinished(producerSpan)
    assert.strictEqual(proc.buckets.size, 1)
  })

  it('should accept spans eligible by span.kind (consumer)', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    const consumerSpan = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'consumer',
      },
      metrics: {},
    }
    proc.onSpanFinished(consumerSpan)
    assert.strictEqual(proc.buckets.size, 1)
  })

  it('should reject spans with internal span.kind and no top-level/measured', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    const internalSpan = {
      ...basicSpan,
      meta: {
        ...basicSpan.meta,
        [SPAN_KIND]: 'internal',
      },
      metrics: {},
    }
    proc.onSpanFinished(internalSpan)
    assert.strictEqual(proc.buckets.size, 0)
  })

  it('should reject spans with no span.kind and no top-level/measured', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    proc.onSpanFinished(basicSpan)
    assert.strictEqual(proc.buckets.size, 0)
  })

  it('should allow setting custom peer tag keys', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    const customKeys = ['custom.tag1', 'custom.tag2']
    proc.setPeerTagKeys(customKeys)
    assert.deepStrictEqual(proc.peerTagKeys, customKeys)
  })

  it('should not override peer tag keys with empty array', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    proc.setPeerTagKeys([])
    assert.deepStrictEqual(proc.peerTagKeys, DEFAULT_PEER_TAGS)
  })

  it('should not override peer tag keys with non-array', () => {
    const proc = new SpanStatsProcessor(config)
    clearTimeout(proc.timer)

    proc.setPeerTagKeys('not-an-array')
    assert.deepStrictEqual(proc.peerTagKeys, DEFAULT_PEER_TAGS)
  })
})

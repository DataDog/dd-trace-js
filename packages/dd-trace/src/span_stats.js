const os = require('os')
const { version } = require('./pkg')
const pkg = require('../../../package.json')

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')
const { ORIGIN_KEY, TOP_LEVEL_KEY } = require('./constants')
const { ERROR } = require('../../../ext/tags')
const {
  MEASURED,
  HTTP_STATUS_CODE,
  SPAN_TYPE,
  RESOURCE_NAME,
  SERVICE_NAME
} = require('../../../ext/tags')

function getTag (span, key) {
  if (!span || !span._spanContext || !span._spanContext._tags) return
  return span._spanContext._tags[key]
}

const { SpanStatsExporter } = require('./exporters/span-stats')

const {
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME
} = require('./encode/tags-processors')

class SpanAggStats {
  constructor (aggKey) {
    this.aggKey = aggKey
    this.hits = 0
    this.topLevelHits = 0
    this.errors = 0
    this.duration = 0
    this.okDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
    this.errorDistribution = new LogCollapsingLowestDenseDDSketch(0.00775)
  }

  record (span) {
    const durationNs = span._duration * 1e6
    this.hits++
    this.duration += durationNs

    if (getTag(span, TOP_LEVEL_KEY)) {
      this.topLevelHits++
    }

    if (getTag(span, ERROR)) {
      this.errors++
      this.errorDistribution.accept(durationNs)
    } else {
      this.okDistribution.accept(durationNs)
    }
  }

  toJSON () {
    const {
      name,
      service,
      resource,
      type,
      statusCode,
      synthetics
    } = this.aggKey

    return {
      Name: name,
      Service: service,
      Resource: resource,
      Type: type,
      HTTPStatusCode: statusCode,
      Synthetics: synthetics,
      Hits: this.hits,
      TopLevelHits: this.topLevelHits,
      Errors: this.errors,
      Duration: this.duration,
      OkSummary: this.okDistribution.toProto(),
      ErrorSummary: this.errorDistribution.toProto()
    }
  }
}

class SpanAggKey {
  constructor (span) {
    this.name = ((span || {})._spanContext || {})._name || DEFAULT_SPAN_NAME
    this.service = getTag(span, SERVICE_NAME) || DEFAULT_SERVICE_NAME
    this.resource = getTag(span, RESOURCE_NAME) || ''
    this.type = getTag(span, SPAN_TYPE) || ''
    this.statusCode = getTag(span, HTTP_STATUS_CODE) || 0
    this.synthetics = getTag(span, ORIGIN_KEY) === 'synthetics'
  }

  toString () {
    return [
      this.name,
      this.service,
      this.resource,
      this.type,
      this.statusCode,
      this.synthetics
    ].join(',')
  }
}

class SpanBuckets extends Map {
  forSpan (span) {
    const aggKey = new SpanAggKey(span)
    const key = aggKey.toString()

    if (!this.has(key)) {
      this.set(key, new SpanAggStats(aggKey))
    }

    return this.get(key)
  }
}

class TimeBuckets extends Map {
  forTime (time) {
    if (!this.has(time)) {
      this.set(time, new SpanBuckets())
    }

    return this.get(time)
  }
}

class SpanStatsProcessor {
  constructor ({
    stats: {
      enabled = false,
      interval = 10
    },
    hostname,
    port,
    url,
    env,
    tags
  } = {}) {
    this.exporter = new SpanStatsExporter({
      hostname,
      port,
      tags,
      url
    })
    this.interval = interval
    this.buckets = new TimeBuckets()
    this.hostname = os.hostname()
    this.enabled = enabled
    this.env = env
    this.tags = tags || {}
    this.sequence = 0

    if (enabled) {
      this.timer = setInterval(this.onInterval.bind(this), interval * 1e3)
      this.timer.unref()
    }
  }

  onInterval () {
    const serialized = this._serializeBuckets()
    if (!serialized) return

    this.exporter.export({
      Hostname: this.hostname,
      Env: this.env,
      Version: version,
      Stats: serialized,
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: this.tags['runtime-id'],
      Sequence: ++this.sequence
    })
  }

  onSpanFinished (span) {
    if (!this.enabled) return
    if (!getTag(span, TOP_LEVEL_KEY) && !getTag(span, MEASURED)) return

    const spanEnd = span._startTime + span._duration
    const bucketTime = spanEnd - (spanEnd % (this.interval * 1e3))

    this.buckets.forTime(bucketTime)
      .forSpan(span)
      .record(span)
  }

  _serializeBuckets () {
    const bucketSizeNs = this.interval * 1e9
    const serializedBuckets = []

    for (const [ timeNs, bucket ] of this.buckets.entries()) {
      const bucketAggStats = []

      for (const stats of bucket.values()) {
        bucketAggStats.push(stats.toJSON())
      }

      serializedBuckets.push({
        Start: timeNs * 1e6,
        Duration: bucketSizeNs,
        Stats: bucketAggStats
      })
    }

    this.buckets.clear()

    return serializedBuckets
  }
}

module.exports = {
  SpanAggStats,
  SpanAggKey,
  SpanBuckets,
  TimeBuckets,
  SpanStatsProcessor
}

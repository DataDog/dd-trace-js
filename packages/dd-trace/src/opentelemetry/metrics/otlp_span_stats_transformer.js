'use strict'

const OtlpTransformerBase = require('../otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../otlp/protobuf_loader')
const { GRPC_STATUS_NAMES } = require('../../constants')

const { stableStringify } = OtlpTransformerBase

const NS_PER_S = 1e9

// Must match libdatadog's EXPLICIT_BOUNDS_SECONDS and OTel spanmetrics connector defaults.
const EXPLICIT_BOUNDS_SECONDS = [
  0.002, 0.004, 0.006, 0.008, 0.01, 0.05, 0.1, 0.2, 0.4, 0.8, 1, 1.4, 2, 5, 10, 15,
]

const SPAN_KIND_METRIC_MAP = {
  internal: 'SPAN_KIND_INTERNAL',
  SPAN_KIND_INTERNAL: 'SPAN_KIND_INTERNAL',
  server: 'SPAN_KIND_SERVER',
  SPAN_KIND_SERVER: 'SPAN_KIND_SERVER',
  client: 'SPAN_KIND_CLIENT',
  SPAN_KIND_CLIENT: 'SPAN_KIND_CLIENT',
  producer: 'SPAN_KIND_PRODUCER',
  SPAN_KIND_PRODUCER: 'SPAN_KIND_PRODUCER',
  consumer: 'SPAN_KIND_CONSUMER',
  SPAN_KIND_CONSUMER: 'SPAN_KIND_CONSUMER',
}

/**
 * @param {object} sketch
 * @returns {number[]}
 */
function sketchToFixedHistogram (sketch) {
  const bucketCounts = new Array(EXPLICIT_BOUNDS_SECONDS.length + 1).fill(0)
  if (sketch.zeroCount > 0) bucketCounts[0] += sketch.zeroCount
  const { store, mapping } = sketch
  for (let key = store.minKey; key <= store.maxKey; key++) {
    const weight = store.bins[key - store.offset]
    if (!weight) continue
    const seconds = mapping.value(key) / NS_PER_S
    let idx = EXPLICIT_BOUNDS_SECONDS.findIndex((bound) => seconds <= bound)
    if (idx === -1) idx = EXPLICIT_BOUNDS_SECONDS.length
    bucketCounts[idx] += weight
  }
  return bucketCounts.map((weight) => Math.round(weight))
}

let _deltaTemporality

function getDeltaTemporality () {
  if (_deltaTemporality === undefined) {
    const { protoAggregationTemporality } = getProtobufTypes()
    _deltaTemporality = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA
  }
  return _deltaTemporality
}

const STATUS_CODE_OK = 'STATUS_CODE_OK'
const STATUS_CODE_ERROR = 'STATUS_CODE_ERROR'

class OtlpStatsTransformer extends OtlpTransformerBase {
  /**
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes
   * @param {string} protocol
   */
  constructor (resourceAttributes, protocol) {
    super(resourceAttributes, protocol, 'span-stats')
  }

  /**
   * @param {Array<{timeNs: number, bucket: import('../../span_stats').SpanBuckets}>} drained
   * @param {number} bucketSizeNs
   */
  transform (drained, bucketSizeNs) {
    const isJson = this.protocol === 'http/json'
    const data = {
      resourceMetrics: [{
        resource: this.transformResource(),
        scopeMetrics: this.#buildScopeMetrics(drained, bucketSizeNs, isJson),
      }],
    }
    return isJson
      ? this.serializeToJson(data)
      : this.serializeToProtobuf(getProtobufTypes().protoMetricsService, data)
  }

  #buildScopeMetrics (drained, bucketSizeNs, isJson) {
    const temporality = isJson ? 'AGGREGATION_TEMPORALITY_DELTA' : getDeltaTemporality()

    const dataPoints = []

    for (const { timeNs, bucket } of drained) {
      const distributions = new Map()
      const endTimeNs = timeNs + bucketSizeNs
      const startNano = isJson ? String(timeNs) : timeNs
      const endNano = isJson ? String(endTimeNs) : endTimeNs

      for (const aggStats of bucket.values()) {
        const baseAttributes = this.#buildAttributes(aggStats.aggKey)
        const baseKey = stableStringify(baseAttributes)

        this.#addDistribution(
          distributions, aggStats.topLevelOkDistribution, startNano, endNano,
          baseAttributes, baseKey, true, STATUS_CODE_OK
        )
        this.#addDistribution(
          distributions, aggStats.topLevelErrorDistribution, startNano, endNano,
          baseAttributes, baseKey, true, STATUS_CODE_ERROR
        )
        this.#addDistribution(
          distributions, aggStats.nonTopLevelOkDistribution, startNano, endNano,
          baseAttributes, baseKey, false, STATUS_CODE_OK
        )
        this.#addDistribution(
          distributions, aggStats.nonTopLevelErrorDistribution, startNano, endNano,
          baseAttributes, baseKey, false, STATUS_CODE_ERROR
        )
      }

      for (const { sketch, startNano, endNano, attributes } of distributions.values()) {
        this.#pushPoint(dataPoints, sketch, startNano, endNano, attributes)
      }
    }

    if (dataPoints.length === 0) return []
    return [{
      metrics: [
        {
          name: 'traces.span.sdk.metrics.duration',
          unit: 's',
          histogram: { dataPoints, aggregationTemporality: temporality },
        },
      ],
    }]
  }

  /**
   * @param {Map<string, {
   *   sketch: object,
   *   startNano: string | number,
   *   endNano: string | number,
   *   attributes: object[]
   * }>} distributions
   * @param {object} sketch
   * @param {string | number} startNano
   * @param {string | number} endNano
   * @param {import('@opentelemetry/api').Attributes} baseAttributes
   * @param {string} baseKey
   * @param {boolean} topLevel
   * @param {string} statusCode
   * @returns {void}
   */
  #addDistribution (distributions, sketch, startNano, endNano, baseAttributes, baseKey, topLevel, statusCode) {
    if (!sketch || sketch.count === 0) return

    const key = `${baseKey},${topLevel},${statusCode}`
    const existing = distributions.get(key)
    if (existing) {
      existing.sketch.merge(sketch)
    } else {
      const attributes = this.transformAttributes(baseAttributes)
      attributes.push(
        { key: 'datadog.span.top_level', value: { boolValue: topLevel } },
        { key: 'status.code', value: { stringValue: statusCode } }
      )
      distributions.set(key, {
        sketch,
        startNano,
        endNano,
        attributes,
      })
    }
  }

  #pushPoint (points, sketch, startNano, endNano, attributes) {
    points.push({
      attributes,
      startTimeUnixNano: startNano,
      timeUnixNano: endNano,
      count: sketch.count,
      sum: sketch.sum / NS_PER_S,
      min: sketch.min / NS_PER_S,
      max: sketch.max / NS_PER_S,
      bucketCounts: sketchToFixedHistogram(sketch),
      explicitBounds: EXPLICIT_BOUNDS_SECONDS,
    })
  }

  /**
   * @param {import('../../span_stats').SpanAggKey} aggKey
   * @returns {import('@opentelemetry/api').Attributes}
   */
  #buildAttributes (aggKey) {
    const spanKind = Object.hasOwn(SPAN_KIND_METRIC_MAP, aggKey.spanKind)
      ? SPAN_KIND_METRIC_MAP[aggKey.spanKind]
      : 'SPAN_KIND_INTERNAL'
    const raw = {
      'span.name': aggKey.resource,
      'service.name': aggKey.service,
      'span.kind': spanKind,
    }

    if (aggKey.statusCode) raw['http.response.status_code'] = Number(aggKey.statusCode)
    if (aggKey.method) raw['http.request.method'] = aggKey.method
    if (aggKey.endpoint) raw['http.route'] = aggKey.endpoint
    if (aggKey.rpcStatusCode !== '') {
      const n = Number(aggKey.rpcStatusCode)
      raw['rpc.response.status_code'] = Number.isInteger(n) && n >= 0 && n < GRPC_STATUS_NAMES.length
        ? GRPC_STATUS_NAMES[n]
        : String(aggKey.rpcStatusCode).toUpperCase()
    }

    // TODO: additional_metric_tags support is still evolving/TBD across most SDKs; not implemented here yet.

    raw['datadog.operation.name'] = aggKey.name
    if (aggKey.type) raw['datadog.span.type'] = aggKey.type
    if (aggKey.synthetics) raw['datadog.origin'] = 'synthetics'
    if (aggKey.srvSrc) raw['datadog.svc_src'] = aggKey.srvSrc
    if (typeof aggKey.isTraceRoot === 'boolean') raw['datadog.is_trace_root'] = aggKey.isTraceRoot

    return raw
  }
}

module.exports = OtlpStatsTransformer
module.exports.EXPLICIT_BOUNDS_SECONDS = EXPLICIT_BOUNDS_SECONDS

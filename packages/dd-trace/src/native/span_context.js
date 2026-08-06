'use strict'

const DatadogSpanContext = require('../opentracing/span_context')
const tags = require('../../../../ext/tags')
const {
  ANALYTICS_KEY,
  HOSTNAME_KEY,
  SAMPLING_PRIORITY_KEY,
} = require('../constants')
const { IGNORE_OTEL_ERROR } = require('../constants')
const {
  applyHttpOtelSemantics,
  DD_HTTP_META_KEYS,
  NETWORK_DESTINATION_PORT,
  OTEL_OUTPUT_META_KEYS,
  OTEL_OUTPUT_METRIC_KEYS,
} = require('../plugins/util/http-otel-semantics')
const {
  MAX_META_KEY_LENGTH,
  MAX_META_VALUE_LENGTH,
  MAX_METRIC_KEY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SERVICE_LENGTH,
  MAX_TYPE_LENGTH,
  MAX_RESOURCE_NAME_LENGTH,
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME,
} = require('../encode/tags-processors')
const { registerExtraService } = require('../service-naming/extra-services')
const { OpCode } = require('./index')
const PROCESS_TAGS_META_KEY = '_dd.tags.process'

/**
 * Span context with an authoritative JS tag cache and final native sync.
 * Final formatting handles deletion and type replacement that WASM cannot.
 */
const { MEASURED } = tags
const ERROR_META_KEYS = new Set(['error.type', 'error.message', 'error.stack'])

function truncateWithEllipsis (value, max) {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function truncateKey (key, max) {
  return key.length > max ? `${key.slice(0, max)}...` : key
}

function normalizeName (name) {
  name ||= DEFAULT_SPAN_NAME
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name
}

function normalizeService (service) {
  service ||= DEFAULT_SERVICE_NAME
  return service.length > MAX_SERVICE_LENGTH ? service.slice(0, MAX_SERVICE_LENGTH) : service
}

function normalizeResource (resource, name) {
  resource ||= name
  return resource.length > MAX_RESOURCE_NAME_LENGTH ? resource.slice(0, MAX_RESOURCE_NAME_LENGTH) : resource
}

function normalizeType (type) {
  return type && type.length > MAX_TYPE_LENGTH ? type.slice(0, MAX_TYPE_LENGTH) : type
}

// Symbol storage preserves a stable hidden class.
const NAME_VALUE = Symbol('nameValue')

class NativeSpanContext extends DatadogSpanContext {
  #nativeSpans

  // Export removes the native span. Ignore later mutations to avoid orphaned
  // operations; the JS pipeline likewise cannot alter an exported payload.
  #exported = false
  #hasErrorTags = false
  #nativeName
  #nativeResource
  #nativeService
  #nativeType
  #nativeError = 0

  /**
   * @param {import('./native_spans')} nativeSpans - The NativeSpansInterface instance
   * @param {object} props - SpanContext properties
   * @param {import('../id')} props.traceId - Trace ID
   * @param {import('../id')} props.spanId - Span ID
   * @param {import('../id')|null} [props.parentId] - Parent span ID
   * @param {object} [props.sampling] - Sampling information
   * @param {object} [props.baggageItems] - Baggage items
   * @param {object} [props.trace] - Shared trace object
   * @param {object} [props.tracestate] - W3C tracestate
   * @param {string} [props.tracerService] - Tracer's configured service name (for BASE_SERVICE)
   * @param {string} [props.tracerServiceLower] - Lowercase tracer service for extra-service registration
   */
  constructor (nativeSpans, props) {
    // Native sync begins after parent construction.
    super(props)

    this.#nativeSpans = nativeSpans

    // Store the handle little-endian once for subsequent queue writes.
    const beBuf = props.spanId.toBuffer()
    const leId = new Uint8Array(8)
    leId[0] = beBuf[7]
    leId[1] = beBuf[6]
    leId[2] = beBuf[5]
    leId[3] = beBuf[4]
    leId[4] = beBuf[3]
    leId[5] = beBuf[2]
    leId[6] = beBuf[1]
    leId[7] = beBuf[0]
    this._nativeSpanId = leId
    this._tracerService = props.tracerService // Store for BASE_SERVICE check
    this._tracerServiceLower = props.tracerServiceLower || ''
  }

  // Intercept name writes without per-instance property definitions.
  get _name () {
    return this[NAME_VALUE]
  }

  set _name (value) {
    this[NAME_VALUE] = value
  }

  /**
   * Record core fields already included in CreateSpanFull.
   *
   * @param {string} name span operation name already queued via CreateSpanFull
   * @param {string|undefined} resource resource name already queued, if any
   * @param {string|undefined} service service name already queued, if any
   * @param {string|undefined} type span type already queued, if any
   */
  _recordNativeCoreFields (name, resource, service, type) {
    this.#nativeName = name
    this.#nativeResource = resource
    this.#nativeService = service
    this.#nativeType = type
  }

  /** Mark the span exported and stop subsequent native writes. */
  markExported () {
    this.#exported = true
  }

  isExported () {
    return this.#exported
  }

  /**
   * Update the authoritative JS tag cache.
   * @param {string | symbol} key Tag key
   * @param {unknown} value Tag value
   */
  setTag (key, value) {
    super.setTag(key, value)
    if (key === 'error' || ERROR_META_KEYS.has(key)) this.#hasErrorTags = true
  }

  /**
   * Observe batched tag writes that bypass setTag.
   * @param {object} tags Tag object
   */
  syncToNativeOnly (tags) {
    if (this.#exported) return
    for (const key of Object.keys(tags)) {
      if (key === 'error' || ERROR_META_KEYS.has(key)) this.#hasErrorTags = true
    }
  }

  /**
   * Observe one direct tag write.
   * @param {string} key
   * @param {unknown} value
   */
  syncOneTagToNative (key, value) {
    if (this.#exported) return
    if (key === 'error' || ERROR_META_KEYS.has(key)) this.#hasErrorTags = true
  }

  /**
   * Use the allocation-light final sync when every tag maps locally.
   * @returns {boolean} Whether fast sync completed
   */
  tryFastFinalTagsToNative () {
    if (this.#exported) return true
    if (this.#hasErrorTags || this._spanSampling !== undefined) return false

    const tags = this.getTags()
    if (this.#hasOtelDeferredTags(tags)) return false

    const metaBatch = []
    const metricBatch = []
    const name = normalizeName(String(this._name))
    let resource
    let service
    let type = ''
    let extraService

    for (const key of Object.keys(tags)) {
      const value = tags[key]
      if (key === 'error' || ERROR_META_KEYS.has(key)) return false

      if (key === 'span.kind' && value && value !== 'internal') {
        metricBatch.push(MEASURED, 1)
      }

      switch (key) {
        case 'service.name':
          if (typeof value !== 'string') return false
          service = normalizeService(truncateWithEllipsis(value, MAX_META_VALUE_LENGTH))
          if (value.toLowerCase() !== this._tracerServiceLower) extraService = value
          break
        case 'resource.name':
          if (typeof value !== 'string') return false
          resource = truncateWithEllipsis(value, MAX_META_VALUE_LENGTH)
          break
        case 'span.type':
          if (typeof value !== 'string') return false
          type = normalizeType(truncateWithEllipsis(value, MAX_META_VALUE_LENGTH))
          break
        case 'http.status_code': {
          const stringValue = value && String(value)
          if (typeof stringValue === 'string') {
            metaBatch.push(key, truncateWithEllipsis(stringValue, MAX_META_VALUE_LENGTH))
          }
          break
        }
        case 'analytics.event':
          metricBatch.push(ANALYTICS_KEY, value === undefined || value ? 1 : 0)
          break
        case HOSTNAME_KEY:
        case MEASURED:
          metricBatch.push(key, value === undefined || value ? 1 : 0)
          break
        default: {
          const valueType = typeof value
          if (valueType === 'string') {
            metaBatch.push(
              truncateKey(key, MAX_META_KEY_LENGTH),
              truncateWithEllipsis(value, MAX_META_VALUE_LENGTH)
            )
          } else if (valueType === 'number') {
            if (!Number.isNaN(value)) metricBatch.push(truncateKey(key, MAX_METRIC_KEY_LENGTH), value)
          } else if (valueType === 'boolean') {
            metricBatch.push(truncateKey(key, MAX_METRIC_KEY_LENGTH), value ? 1 : 0)
          } else if (value != null) {
            return false
          }
        }
      }
    }

    if (typeof this._hostname === 'string') {
      metaBatch.push(HOSTNAME_KEY, truncateWithEllipsis(this._hostname, MAX_META_VALUE_LENGTH))
    }
    if (typeof this._sampling.priority === 'number') {
      metricBatch.push(SAMPLING_PRIORITY_KEY, this._sampling.priority)
    }
    resource = normalizeResource(resource, name)
    if (service === undefined) return false
    service = normalizeService(service)
    type = normalizeType(type)

    if (extraService !== undefined) registerExtraService(extraService)
    this.#syncCoreFields(name, resource, service, type, 0)
    const spanId = this._nativeSpanId
    if (metaBatch.length > 0) this.#nativeSpans.queueBatchMetaFlat(spanId, metaBatch)
    if (metricBatch.length > 0) this.#nativeSpans.queueBatchMetricsFlat(spanId, metricBatch)
    return true
  }

  #syncCoreFields (name, resource, service, type, error) {
    const spanId = this._nativeSpanId
    if (name !== this.#nativeName) {
      this.#nativeSpans.queueOp(OpCode.SetName, spanId, name)
      this.#nativeName = name
    }
    if (resource !== this.#nativeResource) {
      this.#nativeSpans.queueOp(OpCode.SetResourceName, spanId, resource)
      this.#nativeResource = resource
    }
    if (typeof service === 'string' && service !== this.#nativeService) {
      this.#nativeSpans.queueOp(OpCode.SetServiceName, spanId, service)
      this.#nativeService = service
    }
    if (typeof type === 'string' && type !== this.#nativeType) {
      this.#nativeSpans.queueOp(OpCode.SetType, spanId, type)
      this.#nativeType = type
    }
    if (error !== this.#nativeError) {
      this.#nativeSpans.queueOp(OpCode.SetError, spanId, ['i32', error])
      this.#nativeError = error
    }
  }

  #hasOtelDeferredTags (tags) {
    if (!this.#nativeSpans.otelSemanticsEnabled) return false
    for (const key of Object.keys(tags)) {
      if (DD_HTTP_META_KEYS.has(key) || key === NETWORK_DESTINATION_PORT) return true
    }
    return false
  }

  /**
   * Sync a span_format-compatible final representation to native storage.
   * @param {object} formatted
   */
  syncFinalTagsToNative (formatted) {
    if (this.#exported) return

    const spanId = this._nativeSpanId
    const name = String(formatted.name)
    if (name !== this.#nativeName) {
      this.#nativeSpans.queueOp(OpCode.SetName, spanId, name)
      this.#nativeName = name
    }
    const resource = String(formatted.resource)
    if (resource !== this.#nativeResource) {
      this.#nativeSpans.queueOp(OpCode.SetResourceName, spanId, resource)
      this.#nativeResource = resource
    }
    if (typeof formatted.service === 'string' && formatted.service !== this.#nativeService) {
      this.#nativeSpans.queueOp(OpCode.SetServiceName, spanId, formatted.service)
      this.#nativeService = formatted.service
    }
    if (typeof formatted.type === 'string' && formatted.type !== this.#nativeType) {
      this.#nativeSpans.queueOp(OpCode.SetType, spanId, formatted.type)
      this.#nativeType = formatted.type
    }
    const error = formatted.error ? 1 : 0
    if (error !== this.#nativeError) {
      this.#nativeSpans.queueOp(OpCode.SetError, spanId, ['i32', error])
      this.#nativeError = error
    }

    const metaBatch = []
    for (const key of Object.keys(formatted.meta)) {
      if (this.#isOtelDeferredKey(key)) continue
      if (key === PROCESS_TAGS_META_KEY && !this.hasTag(PROCESS_TAGS_META_KEY)) continue
      metaBatch.push(key, formatted.meta[key])
    }
    if (metaBatch.length > 0) {
      this.#nativeSpans.queueBatchMetaFlat(spanId, metaBatch)
    }

    const metricBatch = []
    for (const key of Object.keys(formatted.metrics)) {
      if (this.#isOtelDeferredKey(key)) continue
      const value = formatted.metrics[key]
      if (typeof value === 'number' && !Number.isNaN(value)) metricBatch.push(key, value)
    }
    if (metricBatch.length > 0) {
      this.#nativeSpans.queueBatchMetricsFlat(spanId, metricBatch)
    }
  }

  /** Replay final error metadata using span_format overwrite order. */
  syncErrorMetaToNative () {
    if (this.#exported || !this.#hasErrorTags || this._name === 'fs.operation') return

    const tags = this.getTags()
    for (const key of Object.keys(tags)) {
      const value = tags[key]
      switch (key) {
        case 'error':
          if (value?.message || value instanceof Error) {
            if (value.name) {
              this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, 'error.type', String(value.name))
            }
            if (value.message || value.code) {
              this.#nativeSpans.queueOp(
                OpCode.SetMetaAttr,
                this._nativeSpanId,
                'error.message',
                String(value.message || value.code)
              )
            }
            if (value.stack) {
              this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, 'error.stack', String(value.stack))
            }
          }
          break
        case 'error.type':
        case 'error.message':
        case 'error.stack':
          if (!this.getTag(IGNORE_OTEL_ERROR)) {
            this.#nativeSpans.queueOp(OpCode.SetError, this._nativeSpanId, ['i32', 1])
            this.#nativeError = 1
          }
          if (value != null) {
            this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, key, String(value))
          }
          break
      }
    }
  }

  /**
   * Hold Datadog HTTP keys out of WASM until OTel remapping is complete.
   * @param {string} key
   * @returns {boolean}
   */
  #isOtelDeferredKey (key) {
    return this.#nativeSpans.otelSemanticsEnabled &&
      (DD_HTTP_META_KEYS.has(key) || key === NETWORK_DESTINATION_PORT)
  }

  /**
   * Set a construction-time name without a native operation.
   * @param {string} name Span name
   */
  _setNameLocal (name) {
    this[NAME_VALUE] = name
  }

  /**
   * Sync a changed span name.
   * @param {string} name Span name
   */
  _syncNameToNative (name) {
    const stringName = String(name)
    this.#nativeSpans.queueOp(
      OpCode.SetName,
      this._nativeSpanId,
      stringName
    )
    this.#nativeName = stringName
  }

  /**
   * Apply shared OTel HTTP remapping to the final native representation.
   * Native stats consequently observe the remapped keys under this opt-in.
   */
  applyOtelHttpSemantics () {
    const tags = this.getTags()
    if (tags['http.method'] === undefined && tags['http.url'] === undefined) return

    // Rebuild the native meta/metric categories from the JS cache.
    const meta = {}
    const metrics = {}
    for (const key of Object.keys(tags)) {
      const value = tags[key]
      if (value === null || value === undefined) continue
      if (key === 'http.status_code') {
        meta[key] = String(value)
      } else if (typeof value === 'number') {
        if (!Number.isNaN(value)) metrics[key] = value
      } else if (typeof value === 'boolean') {
        metrics[key] = value ? 1 : 0
      } else {
        meta[key] = String(value)
      }
    }

    const resourceBefore = typeof tags['resource.name'] === 'string' ? tags['resource.name'] : undefined
    const errorBefore = tags.error ? 1 : 0
    const view = { meta, metrics, error: errorBefore, resource: resourceBefore }

    applyHttpOtelSemantics(view)

    const spanId = this._nativeSpanId
    for (const key of OTEL_OUTPUT_META_KEYS) {
      const value = view.meta[key]
      if (value !== undefined) {
        this.#nativeSpans.queueOp(OpCode.SetMetaAttr, spanId, key, String(value))
      }
    }
    for (const key of OTEL_OUTPUT_METRIC_KEYS) {
      const value = view.metrics[key]
      if (value !== undefined) {
        this.#nativeSpans.queueOp(OpCode.SetMetricAttr, spanId, key, ['f64', value])
      }
    }
    // The remap flips error on for error responses; it never clears it.
    if (view.error === 1 && errorBefore !== 1) {
      this.#nativeSpans.queueOp(OpCode.SetError, spanId, ['i32', 1])
      this.#nativeError = 1
    }
    // Only the unknown-verb (_OTHER) path rewrites the resource.
    if (typeof view.resource === 'string' && view.resource !== resourceBefore) {
      this.#nativeSpans.queueOp(OpCode.SetResourceName, spanId, view.resource)
      this.#nativeResource = view.resource
    }
  }
}

module.exports = NativeSpanContext

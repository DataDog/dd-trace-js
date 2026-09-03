'use strict'

const tags = require('../../../ext/tags')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const {
  flushStartupLogs,
  flushFrameworkWarnings,
  flushLoadOrderWarnings,
} = require('../../datadog-instrumentations/src/helpers/check-require-cache')
const Tracer = require('./opentracing/tracer')
const Scope = require('./scope')
const { isError } = require('./util')
const { setStartupLogConfig } = require('./startup-log')
const { DataStreamsCheckpointer, DataStreamsManager, DataStreamsProcessor } = require('./datastreams')
const { IS_SERVERLESS } = require('./serverless')
const { flushServerlessTelemetry } = require('./flush')
const log = require('./log')
// Always-on writer (console.warn), not the channel-gated `log`: these surface regardless of
// DD_TRACE_DEBUG.
const { warn } = require('./log/writer')
const logDiagnostic = message => warn('DATADOG TRACER DIAGNOSTIC - ' + message)

const SPAN_TYPE = tags.SPAN_TYPE
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const MEASURED = tags.MEASURED

class DatadogTracer extends Tracer {
  constructor (config, prioritySampler) {
    super(config, prioritySampler)
    this._dataStreamsProcessor = new DataStreamsProcessor(config)
    this._dataStreamsManager = new DataStreamsManager(this._dataStreamsProcessor)
    this.dataStreamsCheckpointer = new DataStreamsCheckpointer(this)
    this._scope = new Scope()
    setStartupLogConfig(config)
    flushStartupLogs(log)
    // Curated frameworks (e.g. Next.js) silently no-op when loaded first and their users enable
    // no logging (#5430 / #5432), so surface those unconditionally.
    flushFrameworkWarnings(logDiagnostic)
    if (config.startupLogs) {
      flushLoadOrderWarnings(logDiagnostic)
    }

    if (!IS_SERVERLESS) {
      const storeConfig = require('./tracer_metadata')
      const metadata = storeConfig(config)
      if (metadata === undefined) {
        log.warn('Could not store tracer configuration for service discovery')
      }
    }
  }

  configure (config) {
    const { env, sampler } = config
    this._prioritySampler.configure(env, sampler, config)
  }

  // todo[piochelepiotr] These two methods are not related to the tracer, but to data streams monitoring.
  // They should be moved outside of the tracer in the future.
  /**
   * @param {string[]} edgeTags
   * @param {import('./opentracing/span')|null} span
   * @param {number} [payloadSize]
   * @param {number} [pathwayContextSize] See `DataStreamsProcessor#setCheckpoint`.
   * @returns {object|undefined}
   */
  setCheckpoint (edgeTags, span, payloadSize = 0, pathwayContextSize) {
    return this._dataStreamsManager.setCheckpoint(edgeTags, span, payloadSize, pathwayContextSize)
  }

  decodeDataStreamsContext (carrier) {
    return this._dataStreamsManager.decodeDataStreamsContext(carrier)
  }

  setOffset (offsetData) {
    return this._dataStreamsProcessor.setOffset(offsetData)
  }

  trace (name, options, fn) {
    options = { childOf: this.scope().active(), ...options }

    const span = this.startSpan(name, options)

    addTags(span, options)

    try {
      if (fn.length > 1) {
        return this.scope().activate(span, () => fn(span, err => {
          addError(span, err)
          span.finish()
        }))
      }

      const result = this.scope().activate(span, () => fn(span))

      if (result && typeof result.then === 'function') {
        return result.then(
          value => {
            span.finish()
            return value
          },
          err => {
            addError(span, err)
            span.finish()
            throw err
          }
        )
      }
      span.finish()

      return result
    } catch (e) {
      addError(span, e)
      span.finish()
      throw e
    }
  }

  wrap (name, options, fn) {
    const tracer = this
    const shimmer = require('../../datadog-shimmer')

    return shimmer.wrapFunction(fn, original => function (...args) {
      let optionsObj = options
      if (typeof optionsObj === 'function' && typeof fn === 'function') {
        optionsObj = optionsObj.apply(this, args)
      }

      const lastArgId = args.length - 1
      const cb = args[lastArgId]

      if (typeof cb === 'function') {
        const scopeBoundCb = tracer.scope().bind(cb)
        return tracer.trace(name, optionsObj, (span, done) => {
          args[lastArgId] = function (err) {
            done(err)
            return scopeBoundCb.apply(this, arguments)
          }

          return original.apply(this, args)
        })
      }
      return tracer.trace(name, optionsObj, () => original.apply(this, args))
    })
  }

  setUrl (url) {
    this._exporter.setUrl(url)
    this._dataStreamsProcessor.setUrl(url)
  }

  /**
   * Flushes every configured telemetry pipeline for a serverless lifecycle.
   * @param {Function} [done] Called after every configured export completes
   * @param {{ timeout?: number }} [options] Bounds this flush operation.
   */
  flushAll (done, options) {
    const traceExporter = this._exporter
    const spanStats = this._processor?._stats
    const traceFlusher = typeof traceExporter?.flush === 'function'
      ? callback => traceExporter.flush(callback)
      : undefined
    const spanStatsFlusher = typeof spanStats?.forceFlush === 'function'
      ? callback => spanStats.forceFlush(callback)
      : undefined

    flushServerlessTelemetry(done, options, {
      trace: traceFlusher,
      spanStats: spanStatsFlusher,
    })
  }

  scope () {
    return this._scope
  }

  getRumData () {
    if (!this._enableGetRumData) {
      return ''
    }
    const span = this.scope().active().context()
    const traceId = span.toTraceId()
    const traceTime = Date.now()
    return `\
<meta name="dd-trace-id" content="${traceId}" />\
<meta name="dd-trace-time" content="${traceTime}" />`
  }
}

function addError (span, error) {
  if (isError(error)) {
    span.addTags({
      [ERROR_TYPE]: error.name,
      [ERROR_MESSAGE]: error.message,
      [ERROR_STACK]: error.stack,
    })
  }
}

function addTags (span, options) {
  const tags = {}

  if (options.type) tags[SPAN_TYPE] = options.type
  if (options.service) tags[SERVICE_NAME] = options.service
  if (options.resource) tags[RESOURCE_NAME] = options.resource

  tags[MEASURED] = options.measured

  span.addTags(tags)
}

module.exports = DatadogTracer

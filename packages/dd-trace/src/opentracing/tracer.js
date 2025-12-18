'use strict'

const os = require('os')
const Span = require('./span')
const SpanProcessor = require('../span_processor')
const PrioritySampler = require('../priority_sampler')
const TextMapPropagator = require('./propagation/text_map')
const DSMTextMapPropagator = require('./propagation/text_map_dsm')
const HttpPropagator = require('./propagation/http')
const BinaryPropagator = require('./propagation/binary')
const LogPropagator = require('./propagation/log')
const formats = require('../../../../ext/formats')

const log = require('../log')
const runtimeMetrics = require('../runtime_metrics')
const getExporter = require('../exporter')
const SpanContext = require('./span_context')

// Native spans support
const nativeModule = require('../native')
const pkg = require('../../../../package.json')

const REFERENCE_CHILD_OF = 'child_of'
const REFERENCE_FOLLOWS_FROM = 'follows_from'

class DatadogTracer {
  constructor (config, prioritySampler) {
    this._config = config
    this._service = config.service
    this._version = config.version
    this._env = config.env
    this._logInjection = config.logInjection
    this._debug = config.debug
    this._prioritySampler = prioritySampler ?? new PrioritySampler(config.env, config.sampler)
    this._enableGetRumData = config.experimental.enableGetRumData
    this._traceId128BitGenerationEnabled = config.traceId128BitGenerationEnabled

    // Initialize native spans if enabled and available
    this._nativeSpans = null
    if (config.experimental?.nativeSpans?.enabled && nativeModule.available) {
      try {
        const NativeSpansInterface = nativeModule.NativeSpansInterface
        const NativeExporter = require('../exporters/native')

        // Get agent URL from config
        const { URL, format } = require('url')
        const defaults = require('../config_defaults')
        const { url, hostname = defaults.hostname, port } = config
        const agentUrl = url || new URL(format({
          protocol: 'http:',
          hostname,
          port
        }))

        this._nativeSpans = new NativeSpansInterface({
          agentUrl: agentUrl.toString(),
          tracerVersion: pkg.version,
          lang: 'nodejs',
          langVersion: process.version,
          langInterpreter: process.jsEngine || 'v8',
          pid: process.pid,
          tracerService: config.service
        })

        this._exporter = new NativeExporter(config, this._prioritySampler, this._nativeSpans)
        this._processor = new SpanProcessor(this._exporter, this._prioritySampler, config, this._nativeSpans)
        this._url = agentUrl

        log.debug('Native spans mode enabled')
      } catch (e) {
        log.warn('Failed to initialize native spans, falling back to JS implementation:', e)
        this._nativeSpans = null
      }
    }

    // If native init failed or not enabled, use standard exporter
    if (!this._nativeSpans) {
      const Exporter = getExporter(config.experimental.exporter)
      this._exporter = new Exporter(config, this._prioritySampler)
      this._processor = new SpanProcessor(this._exporter, this._prioritySampler, config)
      this._url = this._exporter._url
    }

    this._propagators = {
      [formats.TEXT_MAP]: new TextMapPropagator(config),
      [formats.HTTP_HEADERS]: new HttpPropagator(config),
      [formats.BINARY]: new BinaryPropagator(config),
      [formats.LOG]: new LogPropagator(config),
      [formats.TEXT_MAP_DSM]: new DSMTextMapPropagator(config)
    }
    if (config.reportHostname) {
      this._hostname = os.hostname()
    }
  }

  startSpan (name, options = {}) {
    const parent = options.childOf
      ? getContext(options.childOf)
      : getParent(options.references)

    // as per spec, allow the setting of service name through options
    const tags = {
      'service.name': options?.tags?.service ? String(options.tags.service) : this._service
    }

    // As per unified service tagging spec if a span is created with a service name different from the global
    // service name it will not inherit the global version value
    if (options?.tags?.service && options.tags.service !== this._service) {
      options.tags.version = undefined
    }

    const fields = {
      operationName: options.operationName || name,
      parent,
      tags,
      startTime: options.startTime,
      hostname: this._hostname,
      traceId128BitGenerationEnabled: this._traceId128BitGenerationEnabled,
      integrationName: options.integrationName,
      links: options.links
    }

    let span

    if (this._nativeSpans) {
      // Native mode: create NativeDatadogSpan
      const NativeDatadogSpan = nativeModule.NativeDatadogSpan
      span = new NativeDatadogSpan(
        this,
        this._processor,
        this._prioritySampler,
        fields,
        this._debug,
        this._nativeSpans
      )
    } else {
      // Standard mode: create regular Span
      span = new Span(this, this._processor, this._prioritySampler, fields, this._debug)
    }

    span.addTags(this._config.tags)
    span.addTags(options.tags)

    return span
  }

  inject (context, format, carrier) {
    if (context instanceof Span) {
      context = context.context()
    }

    try {
      if (format !== 'text_map_dsm' && format !== formats.LOG) {
        this._prioritySampler.sample(context)
      }
      this._propagators[format].inject(context, carrier)
    } catch (e) {
      log.error('Error injecting trace', e)
      runtimeMetrics.increment('datadog.tracer.node.inject.errors', true)
    }
  }

  extract (format, carrier) {
    try {
      return this._propagators[format].extract(carrier)
    } catch (e) {
      log.error('Error extracting trace', e)
      runtimeMetrics.increment('datadog.tracer.node.extract.errors', true)
      return null
    }
  }
}

/**
 * Get the span context from a span or a span context.
 *
 * @param {Span|SpanContext} spanContext
 * @returns {SpanContext}
 */
function getContext (spanContext) {
  if (spanContext instanceof Span) {
    spanContext = spanContext.context()
  }

  if (!(spanContext instanceof SpanContext)) {
    spanContext = null
  }

  return spanContext
}

function getParent (references = []) {
  let parent = null

  for (const ref of references) {
    const type = ref.type()

    if (type === REFERENCE_CHILD_OF) {
      parent = ref.referencedContext()
      break
    } else if (type === REFERENCE_FOLLOWS_FROM && !parent) {
      parent = ref.referencedContext()
    }
  }

  return parent
}

module.exports = DatadogTracer

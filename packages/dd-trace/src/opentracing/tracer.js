'use strict'

const os = require('os')
const { URL, format } = require('url')
const SpanProcessor = require('../span_processor')
const JsSpanProcessor = require('../js_span_processor')
const getExporter = require('../exporter')
const PrioritySampler = require('../priority_sampler')
const formats = require('../../../../ext/formats')
const log = require('../log')
const runtimeMetrics = require('../runtime_metrics')
const NativeExporter = require('../exporters/native')
const defaults = require('../config/defaults')
const pkg = require('../../../../package.json')
const Span = require('./span')
const TextMapPropagator = require('./propagation/text_map')
const DSMTextMapPropagator = require('./propagation/text_map_dsm')
const HttpPropagator = require('./propagation/http')
const BinaryPropagator = require('./propagation/binary')
const LogPropagator = require('./propagation/log')

const SpanContext = require('./span_context')

// Lazy-loaded so the libdatadog initialization cost is only paid the first
// time the tracer is constructed. libdatadog is a required dependency, so
// any load-time failure surfaces via `require('../native')` at module-load.
let nativeModule
function getNativeModule () {
  if (nativeModule === undefined) {
    nativeModule = require('../native')
  }
  return nativeModule
}

const REFERENCE_CHILD_OF = 'child_of'
const REFERENCE_FOLLOWS_FROM = 'follows_from'

class DatadogTracer {
  constructor (config, prioritySampler) {
    this._config = config
    this._service = config.service
    // Lowercased once for span_format's per-span base-service comparison.
    this.serviceLower = typeof config.service === 'string' ? config.service.toLowerCase() : ''
    this._version = config.version
    this._env = config.env
    this._logInjection = config.logInjection
    this._debug = config.debug
    this._prioritySampler = prioritySampler ?? new PrioritySampler(config.env, config.sampler)
    this._enableGetRumData = config.experimental.enableGetRumData
    this._traceId128BitGenerationEnabled = config.traceId128BitGenerationEnabled

    // Test Optimization / CI Visibility has its own event model and intake and
    // cannot ride the native (WASM) pipeline, so it runs on the JS span path:
    // plain JS spans, the JS span processor (span_format), and a CI-vis
    // exporter (agentless / agent-proxy / test-worker) selected by getExporter.
    // Regular APM tracing uses the native pipeline below.
    if (config.isCiVisibility) {
      this._isCiVisibility = true
      const Exporter = getExporter(config.experimental.exporter)
      this._exporter = new Exporter(config, this._prioritySampler)
      this._processor = new JsSpanProcessor(this._exporter, this._prioritySampler, config)
      this._url = this._exporter._url

      log.debug('CI Visibility mode enabled (JS span pipeline)')
    } else {
      // Native spans are the only supported APM pipeline. libdatadog is a
      // required dependency; if NativeSpansInterface construction fails, that's
      // a hard error and we let it propagate to the caller.
      const NativeSpansInterface = getNativeModule().NativeSpansInterface

      const { url, hostname = defaults.hostname, port } = config
      const agentUrl = url || new URL(format({
        protocol: 'http:',
        hostname,
        port,
      }))

      this._nativeSpans = new NativeSpansInterface({
        agentUrl: agentUrl.toString(),
        tracerVersion: pkg.version,
        lang: 'nodejs',
        langVersion: process.version,
        langInterpreter: process.jsEngine || 'v8',
        pid: process.pid,
        tracerService: config.service,
        statsEnabled: config.stats?.DD_TRACE_STATS_COMPUTATION_ENABLED || false,
        hostname: config.hostname || os.hostname(),
        env: config.env || '',
        appVersion: config.version || '',
        runtimeId: config.tags?.['runtime-id'] || '',
        otelSemanticsEnabled: config.DD_TRACE_OTEL_SEMANTICS_ENABLED || false,
        // Advertise Datadog-Client-Computed-Stats when we compute stats
        // client-side or run in APM-standalone (apmTracingEnabled=false), so the
        // agent skips its own APM stats/sampling for these traces.
        clientComputedStats: config.stats?.DD_TRACE_STATS_COMPUTATION_ENABLED || config.apmTracingEnabled === false,
      })

      this._exporter = new NativeExporter(config, this._prioritySampler, this._nativeSpans)
      this._processor = new SpanProcessor(this._exporter, this._prioritySampler, config, this._nativeSpans)
      this._url = agentUrl

      log.debug('Native spans mode enabled')
    }

    this._propagators = {
      [formats.TEXT_MAP]: new TextMapPropagator(config),
      [formats.HTTP_HEADERS]: new HttpPropagator(config),
      [formats.BINARY]: new BinaryPropagator(),
      [formats.LOG]: new LogPropagator(config),
      [formats.TEXT_MAP_DSM]: new DSMTextMapPropagator(config),
    }
    if (config.reportHostname) {
      this._hostname = os.hostname()
    }
  }

  startSpan (name, options = {}) {
    const parent = options.childOf
      ? getContext(options.childOf)
      : getParent(options.references)

    const fields = {
      operationName: options.operationName || name,
      parent,
      startTime: options.startTime,
      hostname: this._hostname,
      traceId128BitGenerationEnabled: this._traceId128BitGenerationEnabled,
      integrationName: options.integrationName,
      links: options.links,
    }

    let span
    if (this._isCiVisibility) {
      // CI Visibility uses plain JS spans (see the constructor).
      span = new Span(this, this._processor, this._prioritySampler, fields, this._debug)
    } else {
      const NativeDatadogSpan = getNativeModule().NativeDatadogSpan
      span = new NativeDatadogSpan(
        this,
        this._processor,
        this._prioritySampler,
        fields,
        this._debug,
        this._nativeSpans
      )
    }

    // As per unified service tagging spec if a span is created with a service name different from the global
    // service name it will not inherit the global version value
    const ctx = span.context()
    if (options.tags?.service) {
      if (options.tags.service !== this._service) options.tags.version = undefined
      // as per spec, allow the setting of service name through options; set it
      // after all tags are merged so config/options values take precedence
      // eslint-disable-next-line eslint-rules/eslint-prefer-set-service-name
      ctx.setTag('service.name', String(options.tags.service))
    } else {
      // eslint-disable-next-line eslint-rules/eslint-prefer-set-service-name
      ctx.setTag('service.name', this._service)
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
 * @returns {SpanContext|null}
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

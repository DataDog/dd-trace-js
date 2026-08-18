'use strict'

const os = require('os')
const { URL, format } = require('url')
const SpanProcessor = require('../span_processor')
const getExporter = require('../exporter')
const exporters = require('../../../../ext/exporters')
const PrioritySampler = require('../priority_sampler')
const formats = require('../../../../ext/formats')
const log = require('../log')
const runtimeMetrics = require('../runtime_metrics')
const NativeExporter = require('../exporters/native')
const defaults = require('../config/defaults')
const { getIsAWSLambda } = require('../serverless')
const pkg = require('../../../../package.json')
const Span = require('./span')
const TextMapPropagator = require('./propagation/text_map')
const DSMTextMapPropagator = require('./propagation/text_map_dsm')
const HttpPropagator = require('./propagation/http')
const BinaryPropagator = require('./propagation/binary')
const LogPropagator = require('./propagation/log')

const SpanContext = require('./span_context')

// Lazy-loaded so libdatadog initialization is only paid when its exporter is selected.
// A corrupt install still fails hard; an omitted optional dependency can fall back.
let nativeModule
function getNativeModule () {
  if (nativeModule === undefined) {
    nativeModule = require('../native')
  }
  return nativeModule
}

// An omitted or outdated binding and runtimes without WebAssembly can use the
// JS exporter. Other loader failures indicate a corrupt install and still fail hard.
function isNativeUnavailable (error) {
  if (typeof WebAssembly === 'undefined') return true
  if (error?.code === NATIVE_PIPELINE_UNAVAILABLE) return true
  if (error?.code === NATIVE_AGENTLESS_UNAVAILABLE) return true
  return error?.code === 'MODULE_NOT_FOUND' &&
    /^Cannot find module ['"]@datadog\/libdatadog['"]/.test(String(error.message))
}

const REFERENCE_CHILD_OF = 'child_of'
const REFERENCE_FOLLOWS_FROM = 'follows_from'
const PIPELINE_API_VERSION = 1
const NATIVE_PIPELINE_UNAVAILABLE = 'DD_NATIVE_PIPELINE_UNAVAILABLE'
const NATIVE_AGENTLESS_UNAVAILABLE = 'DD_NATIVE_AGENTLESS_UNAVAILABLE'
const JS_ONLY_EXPORTERS = new Set([exporters.ELECTRON, exporters.LOG])

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

    // Exporters that consume JS-formatted spans stay on the JS exporter pipeline. Lambda
    // also uses it unless native-only OTLP trace export was requested.
    const configuredExporter = config.experimental?.exporter
    const useAgentlessExporter = configuredExporter === exporters.AGENTLESS
    const useOtlpExporter = config.OTEL_TRACES_EXPORTER === 'otlp'
    const useConfiguredJsExporter = JS_ONLY_EXPORTERS.has(configuredExporter)
    const useLambdaJsPipeline = getIsAWSLambda() &&
      !config.isCiVisibility &&
      !useConfiguredJsExporter &&
      !useAgentlessExporter &&
      !useOtlpExporter
    // A custom DNS `lookup` cannot be honoured by the native exporter. libdatadog's
    // shipped transport builds its own `http.request` options and exposes no hook
    // for them (only `setStorage` and the response-header observer), so the
    // callback would be silently dropped and every payload would go wherever the
    // system resolver points. Anyone setting `lookup` is resolving the agent
    // through custom service discovery, so ignoring it is worse than not using
    // the native exporter: use the JS agent exporter, which threads `lookup` into
    // every agent request (exporters/agent/writer.js).
    //
    // Ask config where the value came from rather than comparing it to
    // `dns.lookup`: the dns plugin wraps `dns.lookup` in-place, so an identity
    // check reports "custom" for every default install once that instrumentation
    // is active. A config without `getOrigin` (plain object in tests) is treated
    // as the default, which keeps the native exporter.
    //
    // Configured JS exporters do not use the native transport.
    //
    // OTLP is excluded for a harder reason: OTLP export lives in libdatadog, so
    // the JS exporter cannot do it at all. Routing there would quietly ship every
    // span to the agent instead of the configured collector, which is a worse
    // failure than resolving the collector with the system resolver. OTLP keeps
    // precedence exactly as it does for the Lambda pipeline above, and the
    // unhonoured `lookup` is announced rather than dropped in silence.
    const lookupOrigin = typeof config.getOrigin === 'function' ? config.getOrigin('lookup') : 'default'
    const hasCustomLookup = typeof config.lookup === 'function' && lookupOrigin !== 'default'
    if (hasCustomLookup && useOtlpExporter) {
      log.warn('OTLP trace export cannot honour a custom `lookup`; resolving the collector with the system resolver')
    }
    const useCustomLookup = hasCustomLookup &&
      !config.isCiVisibility &&
      !useConfiguredJsExporter &&
      !useAgentlessExporter &&
      !useOtlpExporter
    const unsupportedApmExporter = configuredExporter &&
      configuredExporter !== exporters.AGENT &&
      !useConfiguredJsExporter &&
      !useAgentlessExporter &&
      !useLambdaJsPipeline &&
      !config.isCiVisibility

    // Built once for every exporter pipeline. Config forces
    // DD_TRACE_STATS_COMPUTATION_ENABLED when it is enabled, so a branch that
    // omits it silently ships v0.6 client stats to the agent instead.
    let otlpStatsExporter
    if (config.OTEL_TRACES_SPAN_METRICS_ENABLED) {
      const { createOtlpSpanStatsExporter } = require('../opentelemetry/metrics')
      otlpStatsExporter = createOtlpSpanStatsExporter(config)
    }

    if (config.isCiVisibility || useConfiguredJsExporter || useLambdaJsPipeline || useCustomLookup) {
      this._isCiVisibility = config.isCiVisibility === true
      const Exporter = getExporter(configuredExporter)
      this._exporter = new Exporter(config, this._prioritySampler)
      this._processor = new SpanProcessor(this._exporter, this._prioritySampler, config, otlpStatsExporter)
      this._url = this._exporter._url

      let message = 'Custom DNS lookup configured (JS span pipeline)'
      if (useConfiguredJsExporter) {
        message = 'Configured "%s" exporter enabled (JS span pipeline)'
      } else if (useLambdaJsPipeline) {
        message = 'AWS Lambda environment detected (JS span pipeline)'
      } else if (config.isCiVisibility) {
        message = 'CI Visibility mode enabled (JS span pipeline)'
      }
      log.debug(message, configuredExporter)
    } else {
      if (unsupportedApmExporter) {
        log.warn(
          'Native exporter ignores unsupported experimental exporter "%s"; using native agent exporter',
          configuredExporter
        )
      }
      let useNativeExporter = true
      let NativeSpansInterface
      try {
        const native = getNativeModule()
        if (native.pipelineApiVersion < PIPELINE_API_VERSION) {
          throw Object.assign(new Error('Installed libdatadog predates encoded trace export'), {
            code: NATIVE_PIPELINE_UNAVAILABLE,
          })
        }
        const statePrototype = native.WasmSpanState?.prototype
        if (typeof statePrototype?.sendEncodedTraces !== 'function') {
          throw Object.assign(new Error('Installed libdatadog does not support encoded trace export'), {
            code: NATIVE_PIPELINE_UNAVAILABLE,
          })
        }
        if (useAgentlessExporter && typeof statePrototype.setAgentlessEndpoint !== 'function') {
          throw Object.assign(new Error('Installed libdatadog does not support native agentless export'), {
            code: NATIVE_AGENTLESS_UNAVAILABLE,
          })
        }
        NativeSpansInterface = native.NativeSpansInterface
      } catch (error) {
        if (isNativeUnavailable(error)) {
          let reason = 'optional dependency @datadog/libdatadog is not installed'
          if (typeof WebAssembly === 'undefined') {
            reason = 'this runtime has no WebAssembly support'
          } else if (error?.code === NATIVE_PIPELINE_UNAVAILABLE) {
            reason = 'the installed @datadog/libdatadog does not support encoded trace export'
          } else if (error?.code === NATIVE_AGENTLESS_UNAVAILABLE) {
            reason = 'the installed @datadog/libdatadog does not support agentless export'
          }
          const useJsOtlpExporter = useOtlpExporter && !useAgentlessExporter
          useNativeExporter = false
          this._isCiVisibility = false
          if (useJsOtlpExporter) {
            const { createOtlpTraceExporter } = require('../opentelemetry/trace')
            this._exporter = createOtlpTraceExporter(config)
          } else {
            const Exporter = getExporter(configuredExporter)
            this._exporter = new Exporter(config, this._prioritySampler)
          }
          this._processor = new SpanProcessor(
            this._exporter,
            this._prioritySampler,
            config,
            otlpStatsExporter
          )
          this._url = this._exporter._url
          log.warn('Native exporter unavailable because %s; using JS exporter pipeline', reason)
        } else {
          throw error
        }
      }

      if (useNativeExporter) {
        const { url, hostname = defaults.hostname, port } = config
        const nativeStatsEnabled = config.stats?.DD_TRACE_STATS_COMPUTATION_ENABLED === true &&
          !config.OTEL_TRACES_SPAN_METRICS_ENABLED &&
          !useAgentlessExporter
        const agentUrl = url || new URL(format({
          protocol: 'http:',
          hostname,
          port,
        }))

        const nativeSpans = new NativeSpansInterface({
          agentUrl: agentUrl.toString(),
          tracerVersion: pkg.version,
          lang: 'nodejs',
          langVersion: process.version,
          // Bun runs on JavaScriptCore; match the legacy agent writer's
          // Datadog-Meta-Lang-Interpreter (process.versions.bun ? 'JavaScriptCore' : 'v8').
          langInterpreter: process.versions.bun ? 'JavaScriptCore' : (process.jsEngine || 'v8'),
          pid: process.pid,
          tracerService: config.service,
          // Native v0.6 client stats and OTLP trace metrics are mutually exclusive
          // (system-tests FR02): when OTLP trace metrics are enabled, config forces
          // DD_TRACE_STATS_COMPUTATION_ENABLED=true so the OTLP stats exporter runs,
          // but the native concentrator must NOT also ship v0.6 stats. Route stats
          // to OTLP only in that case by leaving the native concentrator disabled.
          statsEnabled: nativeStatsEnabled,
          hostname: config.hostname || os.hostname(),
          env: config.env || '',
          appVersion: config.version || '',
          runtimeId: config.tags?.['runtime-id'] || '',
          // Advertise Datadog-Client-Computed-Stats when we compute stats
          // client-side or run in APM-standalone (apmTracingEnabled=false), so the
          // agent skips its own APM stats/sampling for these traces.
          clientComputedStats: config.stats?.DD_TRACE_STATS_COMPUTATION_ENABLED || config.apmTracingEnabled === false,
        })

        this._exporter = new NativeExporter(config, this._prioritySampler, nativeSpans)
        this._processor = new SpanProcessor(
          this._exporter,
          this._prioritySampler,
          config,
          otlpStatsExporter,
          nativeStatsEnabled
        )
        this._url = agentUrl

        log.debug('Native exporter enabled')
      }
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

    const span = new Span(this, this._processor, this._prioritySampler, fields, this._debug)

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

  /**
   * @param {Span|SpanContext} context
   * @param {string} format
   * @param {object} [carrier]
   * @returns {object | undefined}
   */
  inject (context, format, carrier) {
    if (context instanceof Span) {
      context = context.context()
    }

    try {
      if (format !== 'text_map_dsm' && format !== formats.LOG) {
        this._prioritySampler.sample(context)
      }
      return this._propagators[format].inject(context, carrier)
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

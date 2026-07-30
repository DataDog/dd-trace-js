'use strict'

const os = require('os')
const fs = require('fs')
const { URL, format } = require('url')
const SpanProcessor = require('../span_processor')
const JsSpanProcessor = require('../js_span_processor')
const getExporter = require('../exporter')
const exporters = require('../../../../ext/exporters')
const PrioritySampler = require('../priority_sampler')
const formats = require('../../../../ext/formats')
const log = require('../log')
const runtimeMetrics = require('../runtime_metrics')
const NativeExporter = require('../exporters/native')
const defaults = require('../config/defaults')
const { getIsAWSLambda } = require('../serverless')
const { DATADOG_LAMBDA_EXTENSION_PATH, DATADOG_MINI_AGENT_PATH } = require('../constants')
const pkg = require('../../../../package.json')
const Span = require('./span')
const TextMapPropagator = require('./propagation/text_map')
const DSMTextMapPropagator = require('./propagation/text_map_dsm')
const HttpPropagator = require('./propagation/http')
const BinaryPropagator = require('./propagation/binary')
const LogPropagator = require('./propagation/log')

const SpanContext = require('./span_context')

// Lazy-loaded so the libdatadog initialization cost is only paid the first
// time native spans are selected. A corrupt native install still fails hard;
// an omitted optional @datadog/libdatadog can fall back to JS agent export.
let nativeModule
function getNativeModule () {
  if (nativeModule === undefined) {
    nativeModule = require('../native')
  }
  return nativeModule
}

// Two distinct ways the native pipeline can be unavailable on a runtime that is
// otherwise fine, both of which must degrade to the JS pipeline rather than
// abort tracer construction (proxy.js swallows the throw into a NoopTracer, so
// rethrowing here silently disables tracing altogether):
//
//   1. the optional dependency was not installed;
//   2. the runtime has no `WebAssembly` - `node --jitless`, and any hardened or
//      JIT-disabled deployment. libdatadog's loader throws a bare ReferenceError
//      there, with no `code` to match on.
//
// A corrupt native install is neither, and still fails hard.
function isNativeUnavailable (error) {
  if (typeof WebAssembly === 'undefined') return true
  return error?.code === 'MODULE_NOT_FOUND' &&
    /^Cannot find module ['"]@datadog\/libdatadog['"]/.test(String(error.message))
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
    // The electron APM exporter also rides the JS pipeline: it consumes
    // JS-formatted spans and publishes them over the electron diagnostic
    // channel instead of shipping to the agent, so it can't use native spans.
    // AWS Lambda layers intentionally omit optional dependencies such as
    // @datadog/libdatadog, so they keep using the legacy JS agent pipeline
    // unless the user explicitly requested native-only OTLP trace export.
    const configuredExporter = config.experimental?.exporter
    const useOtlpExporter = config.OTEL_TRACES_EXPORTER === 'otlp'
    const useElectronExporter = configuredExporter === exporters.ELECTRON
    const useLambdaJsPipeline = getIsAWSLambda() &&
      !config.isCiVisibility &&
      !useElectronExporter &&
      !useOtlpExporter
    // A Lambda with neither the Datadog extension layer nor the mini agent has no
    // local agent to receive traces: the Datadog Forwarder ships them from stdout
    // instead. Probe for both markers exactly as the pre-native-spans exporter
    // selection did, otherwise these functions POST every span to a loopback port
    // nothing listens on (config forces flushInterval=0 there) and lose all traces.
    //
    // An explicit `exporter: 'agent'` still wins: master's `getExporter` matched
    // the configured name in a switch and returned before it ever reached this
    // probe, so a Lambda told to use the agent must use the agent.
    //
    // Kept independent of `useLambdaJsPipeline` (which excludes OTLP) so the
    // missing-libdatadog degrade path below can reuse it.
    const lambdaWithoutLocalAgent = getIsAWSLambda() &&
      configuredExporter !== exporters.AGENT &&
      !fs.existsSync(DATADOG_LAMBDA_EXTENSION_PATH) &&
      !fs.existsSync(DATADOG_MINI_AGENT_PATH)
    const useLambdaLogExporter = useLambdaJsPipeline && lambdaWithoutLocalAgent
    // A custom DNS `lookup` cannot be honoured on the native path. libdatadog's
    // shipped transport builds its own `http.request` options and exposes no hook
    // for them (only `setStorage` and the response-header observer), so the
    // callback would be silently dropped and every payload would go wherever the
    // system resolver points. Anyone setting `lookup` is resolving the agent
    // through custom service discovery, so ignoring it is worse than not using
    // native spans: run them on the JS pipeline, which threads `lookup` into
    // every agent request (exporters/agent/writer.js).
    //
    // Ask config where the value came from rather than comparing it to
    // `dns.lookup`: the dns plugin wraps `dns.lookup` in-place, so an identity
    // check reports "custom" for every default install once that instrumentation
    // is active. A config without `getOrigin` (plain object in tests) is treated
    // as the default, which keeps the native pipeline.
    //
    // CI Visibility and electron pick their own exporters below and neither goes
    // through the native transport, so they are unaffected by this.
    const lookupOrigin = typeof config.getOrigin === 'function' ? config.getOrigin('lookup') : 'default'
    const useCustomLookup = typeof config.lookup === 'function' &&
      lookupOrigin !== 'default' &&
      !config.isCiVisibility &&
      !useElectronExporter
    const unsupportedApmExporter = configuredExporter &&
      configuredExporter !== exporters.AGENT &&
      !useElectronExporter &&
      !useLambdaJsPipeline &&
      !config.isCiVisibility

    // Built once for every pipeline: the JS and native processors both take it,
    // and config forces DD_TRACE_STATS_COMPUTATION_ENABLED when it is enabled, so
    // a branch that omits it silently ships v0.6 client stats to the agent instead.
    let otlpStatsExporter
    if (config.OTEL_TRACES_SPAN_METRICS_ENABLED) {
      const { createOtlpSpanStatsExporter } = require('../opentelemetry/metrics')
      otlpStatsExporter = createOtlpSpanStatsExporter(config)
    }

    if (config.isCiVisibility || useElectronExporter || useLambdaJsPipeline || useCustomLookup) {
      this._useJsSpans = true
      this._isCiVisibility = config.isCiVisibility === true
      const Exporter = useElectronExporter
        ? require('../exporters/electron')
        : useLambdaLogExporter
          ? require('../exporters/log')
          : useLambdaJsPipeline || useCustomLookup
            ? require('../exporters/agent')
            : getExporter(configuredExporter)
      this._exporter = new Exporter(config, this._prioritySampler)
      this._processor = new JsSpanProcessor(this._exporter, this._prioritySampler, config, otlpStatsExporter)
      this._url = this._exporter._url

      log.debug(useElectronExporter
        ? 'Electron exporter enabled (JS span pipeline)'
        : useLambdaLogExporter
          ? 'AWS Lambda environment detected without a local agent (JS span pipeline, stdout export)'
          : useLambdaJsPipeline
            ? 'AWS Lambda environment detected (JS span pipeline)'
            : config.isCiVisibility
              ? 'CI Visibility mode enabled (JS span pipeline)'
              : 'Custom DNS lookup configured (JS span pipeline)')
    } else {
      if (unsupportedApmExporter) {
        log.warn(
          'Native spans mode ignores unsupported experimental exporter "%s"; using native agent exporter',
          configuredExporter
        )
      }
      this._useJsSpans = false
      let NativeSpansInterface
      try {
        NativeSpansInterface = getNativeModule().NativeSpansInterface
      } catch (e) {
        if (isNativeUnavailable(e)) {
          const reason = typeof WebAssembly === 'undefined'
            ? 'this runtime has no WebAssembly support'
            : 'optional dependency @datadog/libdatadog is not installed'
          if (config.OTEL_TRACES_EXPORTER === 'otlp') {
            // OTLP export lives in libdatadog, so it cannot be honoured here.
            // Degrade rather than aborting tracer construction: proxy.js swallows
            // a throw and leaves a NoopTracer, which means zero telemetry — and
            // AWS Lambda layers deliberately omit this optional dependency, so
            // OTLP + Lambda would otherwise always be untraced.
            log.error(
              'OTLP trace export is unavailable because %s; %s instead',
              reason,
              lambdaWithoutLocalAgent ? 'writing traces to stdout' : 'using agent export'
            )
          }
          this._useJsSpans = true
          this._isCiVisibility = false
          // Same probe as the JS-pipeline branch: a Lambda with no local agent
          // must not be handed an HTTP exporter pointed at a dead loopback port.
          const Exporter = lambdaWithoutLocalAgent
            ? require('../exporters/log')
            : require('../exporters/agent')
          this._exporter = new Exporter(config, this._prioritySampler)
          this._processor = new JsSpanProcessor(
            this._exporter,
            this._prioritySampler,
            config,
            otlpStatsExporter
          )
          this._url = this._exporter._url
          log.warn('Native spans unavailable because %s; using JS span pipeline', reason)
        } else {
          throw e
        }
      }

      if (!this._useJsSpans) {
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
          statsEnabled: (config.stats?.DD_TRACE_STATS_COMPUTATION_ENABLED &&
          !config.OTEL_TRACES_SPAN_METRICS_ENABLED) || false,
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
        this._processor = new SpanProcessor(
          this._exporter,
          this._prioritySampler,
          config,
          this._nativeSpans,
          otlpStatsExporter
        )
        this._url = agentUrl

        log.debug('Native spans mode enabled')
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

    let span
    if (this._useJsSpans) {
      // CI Visibility + the electron exporter use plain JS spans (see the constructor).
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

    // As per unified service tagging, a span whose service differs from the
    // global service must not inherit the global version. The JS formatter
    // dropped the `undefined` version override at format time; the native tag
    // sync skips undefined values (it can't clear an already-synced meta), so
    // omit version from the config tags up front instead.
    if (options.tags?.service && options.tags.service !== this._service) {
      const { version, ...configTagsWithoutVersion } = this._config.tags
      span.addTags(configTagsWithoutVersion)
    } else {
      span.addTags(this._config.tags)
    }
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

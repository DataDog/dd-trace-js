'use strict'

const { isDeepStrictEqual } = require('node:util')

const { VALID_PROPAGATION_STYLES } = require('../config/parsers')
const { getLogLevel } = require('../log/writer')

/**
 * @typedef {Readonly<{
 *   protocol: string,
 *   resourceAttributes: Readonly<Record<string, unknown>>,
 * }>} InitializedExporter
 * @typedef {Readonly<{
 *   tracing?: boolean,
 *   traces?: InitializedExporter,
 *   metrics?: InitializedExporter,
 *   logs?: InitializedExporter,
 *   spanMetrics?: InitializedExporter,
 * }>} Pipelines
 */

/**
 * @param {ReturnType<import('../config')>} config
 * @param {import('../sampling_rule')[]} rules
 * @param {Pipelines} [pipelines]
 * @returns {Record<string, unknown>}
 */
function startupConfig (config, rules, pipelines = {}) {
  const tracing = !!pipelines.tracing
  const traces = !!pipelines.traces
  const metrics = !!pipelines.metrics
  const logs = !!pipelines.logs
  const spanMetrics = !!pipelines.spanMetrics
  const resources = [pipelines.traces, pipelines.metrics, pipelines.logs, pipelines.spanMetrics]
    .filter(exporter => exporter !== undefined)
    .map(exporter => exporter.resourceAttributes)
  const attributes = commonResourceAttributes(resources)

  /** @type {Record<string, unknown>} */
  const out = {
    OTEL_ENABLED: traces || metrics || logs || spanMetrics ||
      (tracing && (config.otelSdkEnabled || config.DD_TRACE_OTEL_SEMANTICS_ENABLED)),
    DD_TRACE_OTEL_ENABLED: !!config.DD_TRACE_OTEL_ENABLED,
    DD_TRACE_OTEL_SEMANTICS_ENABLED: !!config.DD_TRACE_OTEL_SEMANTICS_ENABLED,
    DD_METRICS_OTEL_ENABLED: !!config.DD_METRICS_OTEL_ENABLED,
    DD_LOGS_OTEL_ENABLED: !!config.DD_LOGS_OTEL_ENABLED,
    OTEL_LOG_LEVEL: getLogLevel(),
    OTEL_SERVICE_NAME: typeof attributes['service.name'] === 'string'
      ? attributes['service.name']
      : undefined,
    OTEL_RESOURCE_ATTRIBUTES: attributes,
    OTEL_LOGS_EXPORTER: logs ? 'otlp' : 'none',
    OTEL_TRACES_SPAN_METRICS_ENABLED: spanMetrics,
    otlp_traces_export_enabled: traces,
    otlp_metrics_export_enabled: metrics,
    otlp_logs_export_enabled: logs,
  }

  if (tracing) {
    const { inject, extract } = config.tracePropagationStyle
    if (config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT === 'continue' &&
        inject.length === extract.length &&
        inject.every((name, i) => name === extract[i] && VALID_PROPAGATION_STYLES.has(name))) {
      const propagators = inject.filter(name => name !== 'none')
        .map(name => name === 'b3 single header' ? 'b3' : name)
      out.OTEL_PROPAGATORS = propagators.join(',') || 'none'
    }
    const firstRule = rules[0]
    if (config.apmTracingEnabled !== false && firstRule) {
      // Normalized rules append a global fallback only when its rate is configured.
      const globalRuleCount = config.sampler.sampleRate === undefined ? 0 : 1
      if (rules.length > globalRuleCount) {
        out.OTEL_TRACES_SAMPLER = 'datadog_custom_rules'
      } else {
        const rate = firstRule.sampleRate
        out.OTEL_TRACES_SAMPLER = rate === 0
          ? 'parentbased_always_off'
          : rate === 1 ? 'parentbased_always_on' : 'parentbased_traceidratio'
        if (rate > 0 && rate < 1) out.OTEL_TRACES_SAMPLER_ARG = rate
      }
    }
  }

  if (pipelines.traces) {
    Object.assign(out, buildSanitizedExporterConfig(config, 'TRACES', pipelines.traces.protocol))
    out.OTEL_TRACES_EXPORTER = 'otlp'
  }
  const metricsExporter = pipelines.metrics || pipelines.spanMetrics
  if (metricsExporter) {
    Object.assign(out, buildSanitizedExporterConfig(config, 'METRICS', metricsExporter.protocol))
  }
  if (metrics) {
    out.OTEL_METRIC_EXPORT_INTERVAL = config.OTEL_METRIC_EXPORT_INTERVAL
    out.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE =
      config.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE.toLowerCase()
  }
  if (pipelines.logs) {
    Object.assign(out, buildSanitizedExporterConfig(config, 'LOGS', pipelines.logs.protocol))
    out.OTEL_BLRP_SCHEDULE_DELAY = config.OTEL_BSP_SCHEDULE_DELAY
    out.OTEL_BLRP_MAX_EXPORT_BATCH_SIZE = config.OTEL_BSP_MAX_EXPORT_BATCH_SIZE
  }
  return out
}

/**
 * @param {Readonly<Record<string, unknown>>[]} resources
 * @returns {Record<string, unknown>}
 */
function commonResourceAttributes (resources) {
  const [reference, ...others] = resources
  /** @type {Record<string, unknown>} */
  const shared = {}

  if (!reference) return shared

  for (const [key, value] of Object.entries(reference)) {
    const supported = isAttributeValue(value) ||
      (Array.isArray(value) && value.every(isAttributeValue))
    if (!supported) continue

    const matchesEveryResource = others.every(resource =>
      Object.hasOwn(resource, key) && isDeepStrictEqual(resource[key], value))
    if (!matchesEveryResource) continue

    shared[key] = Array.isArray(value) ? [...value] : value
  }

  return shared
}

/** @param {unknown} value */
function isAttributeValue (value) {
  return typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
}

/**
 * @param {ReturnType<import('../config')>} config
 * @param {'TRACES' | 'METRICS' | 'LOGS'} signal
 * @param {string} protocol
 * @returns {Record<string, unknown>}
 */
function buildSanitizedExporterConfig (config, signal, protocol) {
  const prefix = `OTEL_EXPORTER_OTLP_${signal}`
  const endpoint = sanitizeEndpoint(config[`${prefix}_ENDPOINT`])
  return {
    ...(endpoint && { [`${prefix}_ENDPOINT`]: endpoint }),
    [`${prefix}_PROTOCOL`]: protocol,
    [`${prefix}_HEADERS`]: redactHeaders(config[`${prefix}_HEADERS`]),
    [`${prefix}_TIMEOUT`]: config[`${prefix}_TIMEOUT`],
  }
}

/** @param {string} endpoint */
function sanitizeEndpoint (endpoint) {
  let sanitized
  try {
    const url = new URL(endpoint)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    if (url.protocol === 'http:' || url.protocol === 'https:') sanitized = url.href
  } catch {
    // A malformed endpoint has no safe representation in diagnostics.
  }
  return sanitized
}

/**
 * @param {Record<string, string> | undefined} headers
 * @returns {Record<string, string>}
 */
function redactHeaders (headers) {
  return Object.fromEntries(Object.keys(headers ?? {}).map(name => [name, '<redacted>']))
}

module.exports = startupConfig

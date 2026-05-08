'use strict'

const { VERSION } = require('../../../../../version')
const OtlpHttpTraceExporter = require('./otlp_http_trace_exporter')

/**
 * @typedef {import('../../config/config-base')} Config
 * @typedef {import('../../opentracing/tracer')} DatadogTracer
 */

/**
 * OpenTelemetry Trace Export for dd-trace-js
 *
 * This module provides OTLP trace export support that integrates with
 * the existing Datadog tracing pipeline. When enabled, the OTLP exporter
 * replaces the default Datadog Agent exporter at tracer initialization time.
 *
 * Key Components:
 * - OtlpHttpTraceExporter: Exports spans via OTLP over HTTP/JSON (port 4318)
 * - OtlpTraceTransformer: Transforms DD-formatted spans to OTLP JSON format
 *
 * When enabled, traces are exported exclusively via OTLP. The original
 * Datadog Agent exporter is replaced.
 *
 * @package
 */

/**
 * Builds resource attributes from the tracer configuration.
 *
 * @param {Config} config - Tracer configuration instance
 * @returns {import('@opentelemetry/api').Attributes} Resource attributes
 */
function buildResourceAttributes (config) {
  const resourceAttributes = {
    'service.name': config.service,
    'telemetry.sdk.name': 'datadog',
    'telemetry.sdk.version': VERSION,
    'telemetry.sdk.language': 'nodejs',
  }

  if (config.env) resourceAttributes['deployment.environment.name'] = config.env
  if (config.version) resourceAttributes['service.version'] = config.version

  const { service, version, env, ...filteredTags } = config.tags
  Object.assign(resourceAttributes, filteredTags)

  return resourceAttributes
}

/**
 * Creates the OTLP HTTP/JSON trace exporter.
 *
 * @param {Config} config - Tracer configuration instance
 * @returns {OtlpHttpTraceExporter} The OTLP HTTP/JSON exporter
 */
function createOtlpTraceExporter (config) {
  return new OtlpHttpTraceExporter(
    config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    config.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
    config.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT,
    buildResourceAttributes(config)
  )
}

module.exports = {
  OtlpHttpTraceExporter,
  buildResourceAttributes,
  createOtlpTraceExporter,
}

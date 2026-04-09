'use strict'

const { VERSION } = require('../../../../../version')
const OtlpHttpTraceExporter = require('./otlp_http_trace_exporter')

/**
 * @typedef {import('../../config')} Config
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
    'service.name': config.service || config.tags.service,
    'telemetry.sdk.name': 'datadog',
    'telemetry.sdk.version': VERSION,
    'telemetry.sdk.language': 'nodejs',
  }

  const env = config.env || config.tags.env
  if (env) resourceAttributes['deployment.environment'] = env
  const version = config.version || config.tags.version
  if (version) resourceAttributes['service.version'] = version

  if (config.tags) {
    const { service, version, env, ...filteredTags } = config.tags
    Object.assign(resourceAttributes, filteredTags)
  }

  return resourceAttributes
}

/**
 * Creates the OTLP HTTP/JSON trace exporter.
 *
 * @param {Config} config - Tracer configuration instance
 * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
 * @returns {OtlpHttpTraceExporter} The OTLP HTTP/JSON exporter
 */
function createOtlpTraceExporter (config, resourceAttributes) {
  return new OtlpHttpTraceExporter(
    config.otelTracesUrl,
    config.otelTracesHeaders,
    config.otelTracesTimeout,
    resourceAttributes
  )
}

module.exports = {
  OtlpHttpTraceExporter,
  buildResourceAttributes,
  createOtlpTraceExporter,
}

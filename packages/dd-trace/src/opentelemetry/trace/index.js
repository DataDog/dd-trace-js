'use strict'

const OtlpHttpTraceExporter = require('./otlp_http_trace_exporter')

/**
 * @typedef {import('../../config')} Config
 * @typedef {import('../../opentracing/tracer')} DatadogTracer
 */

/**
 * OpenTelemetry Trace Export for dd-trace-js
 *
 * This module provides OTLP trace export support that integrates with
 * the existing Datadog tracing pipeline. It hooks into the SpanProcessor's
 * exporter to send DD-formatted spans to an OTLP endpoint instead of the
 * Datadog Agent.
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
  }

  const env = config.env || config.tags.env
  if (env) resourceAttributes['deployment.environment.name'] = env
  const version = config.version || config.tags.version
  if (version) resourceAttributes['service.version'] = version

  if (config.tags) {
    const filteredTags = { ...config.tags }
    delete filteredTags.service
    delete filteredTags.version
    delete filteredTags.env
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

/**
 * Initializes OTLP trace export by replacing the existing span exporter
 * so that spans are sent exclusively to the OTLP endpoint.
 *
 * @param {Config} config - Tracer configuration instance
 * @param {DatadogTracer} tracer - The Datadog tracer instance
 */
function initializeOtlpTraceExport (config, tracer) {
  const resourceAttributes = buildResourceAttributes(config)
  const otlpExporter = createOtlpTraceExporter(config, resourceAttributes)

  tracer._processor._exporter = otlpExporter
}

module.exports = {
  OtlpHttpTraceExporter,
  initializeOtlpTraceExport,
}

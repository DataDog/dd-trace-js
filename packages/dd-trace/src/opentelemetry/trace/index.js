'use strict'

const os = require('os')

const log = require('../../log')
const OtlpHttpTraceExporter = require('./otlp_http_trace_exporter')
const OtlpGrpcTraceExporter = require('./otlp_grpc_trace_exporter')

/**
 * @typedef {import('../../config')} Config
 * @typedef {import('../../opentracing/tracer')} DatadogTracer
 */

/**
 * OpenTelemetry Trace Export for dd-trace-js
 *
 * This module provides OTLP trace export support that integrates with
 * the existing Datadog tracing pipeline. It hooks into the SpanProcessor's
 * exporter to additionally send DD-formatted spans to an OTLP endpoint.
 *
 * Key Components:
 * - OtlpHttpTraceExporter: Exports spans via OTLP over HTTP (port 4318)
 * - OtlpGrpcTraceExporter: Exports spans via OTLP over gRPC (port 4317)
 * - OtlpTraceTransformer: Transforms DD-formatted spans to OTLP format
 *
 * This supports dual-export: spans continue to flow to the DD Agent via the
 * existing exporter, and are additionally sent to an OTLP endpoint.
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
    'service.version': config.version,
    'deployment.environment': config.env,
  }

  // Add all tracer tags (includes DD_TAGS, OTEL_RESOURCE_ATTRIBUTES, DD_TRACE_TAGS, etc.)
  // Exclude Datadog-style keys that duplicate OpenTelemetry standard keys
  if (config.tags) {
    const filteredTags = { ...config.tags }
    delete filteredTags.service
    delete filteredTags.version
    delete filteredTags.env
    Object.assign(resourceAttributes, filteredTags)
  }

  if (config.reportHostname) {
    resourceAttributes['host.name'] = os.hostname()
  }

  return resourceAttributes
}

/**
 * Creates the appropriate OTLP trace exporter based on the configured protocol.
 *
 * @param {Config} config - Tracer configuration instance
 * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
 * @returns {OtlpHttpTraceExporter|OtlpGrpcTraceExporter} The OTLP exporter
 */
function createOtlpTraceExporter (config, resourceAttributes) {
  if (config.otelTracesProtocol === 'grpc') {
    return new OtlpGrpcTraceExporter(
      config.otelTracesUrl,
      config.otelTracesHeaders,
      config.otelTracesTimeout,
      resourceAttributes
    )
  }

  return new OtlpHttpTraceExporter(
    config.otelTracesUrl,
    config.otelTracesHeaders,
    config.otelTracesTimeout,
    config.otelTracesProtocol,
    resourceAttributes
  )
}

/**
 * Initializes OTLP trace export by wrapping the existing span exporter
 * with a composite that sends spans to both the DD Agent and an OTLP endpoint.
 *
 * @param {Config} config - Tracer configuration instance
 * @param {DatadogTracer} tracer - The Datadog tracer instance
 */
function initializeOtlpTraceExport (config, tracer) {
  const resourceAttributes = buildResourceAttributes(config)
  const otlpExporter = createOtlpTraceExporter(config, resourceAttributes)

  // Wrap the existing exporter in the span processor for dual-export.
  // The original exporter (e.g. AgentExporter) continues to receive spans,
  // and the OTLP exporter additionally receives the same formatted spans.
  const processor = tracer._processor
  const originalExporter = processor._exporter

  processor._exporter = {
    export (spans) {
      originalExporter.export(spans)
      try {
        otlpExporter.export(spans)
      } catch (err) {
        log.error('Error exporting OTLP traces:', err)
      }
    },

    setUrl (url) {
      originalExporter.setUrl?.(url)
    },

    flush (done) {
      originalExporter.flush?.(done)
    },

    get _url () {
      return originalExporter._url
    },
  }
}

module.exports = {
  OtlpHttpTraceExporter,
  OtlpGrpcTraceExporter,
  initializeOtlpTraceExport,
}

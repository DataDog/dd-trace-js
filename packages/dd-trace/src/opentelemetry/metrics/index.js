'use strict'

const os = require('os')

const { metrics } = require('@opentelemetry/api')

const { VERSION } = require('../../../../../version')
const processTags = require('../../process-tags')
const MeterProvider = require('./meter_provider')
const PeriodicMetricReader = require('./periodic_metric_reader')
const OtlpHttpMetricExporter = require('./otlp_http_metric_exporter')

/**
 * @typedef {import('../../config')} Config
 */

// Tracks the currently-active exporters so `refreshResourceAttributes` can push updated
// resource attributes (e.g. a reseeded `runtime-id`) into their caches. Undefined if OTel
// metrics / span-stats were never initialized.
let activeMetricsExporter
let activeStatsExporter

/**
 * @file OpenTelemetry Metrics Implementation for dd-trace-js
 *
 * This package provides a custom OpenTelemetry Metrics implementation that integrates
 * with the Datadog tracing library. It includes all necessary components for
 * creating instruments, recording measurements, and exporting metrics via OTLP.
 *
 * Key Components:
 * - MeterProvider: Main entry point for creating meters
 * - Meter: Provides methods to create metric instruments
 * - Instruments: Gauge, Counter, UpDownCounter, ObservableGauge, ObservableCounter, ObservableUpDownCounter, Histogram
 * - PeriodicMetricReader: Collects and exports instruments (metrics) at regular intervals
 * - OtlpHttpMetricExporter: Exports instruments (metrics) via OTLP over HTTP
 * - OtlpTransformer: Transforms instruments (metrics) to OTLP format
 *
 * This is a custom implementation to avoid pulling in the full OpenTelemetry SDK,
 * based on OTLP Protocol v1.7.0. It supports both protobuf and JSON serialization
 * formats and integrates with Datadog's configuration system.
 *
 * @package
 */

/**
 * Builds the resource attributes for the OTel metrics (non-span-stats) exporter.
 * @param {import('../../config/config-base')} config - Tracer configuration instance
 * @returns {object} Resource attributes
 */
function buildMetricsResourceAttributes (config) {
  const resourceAttributes = {
    'service.name': config.service,
    'service.version': config.version,
    'deployment.environment': config.env,
  }

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
 * Initializes OpenTelemetry Metrics support
 * @param {import('../../config/config-base')} config - Tracer configuration instance
 */
function initializeOpenTelemetryMetrics (config) {
  const resourceAttributes = buildMetricsResourceAttributes(config)

  const exporter = new OtlpHttpMetricExporter(
    config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    config.OTEL_EXPORTER_OTLP_METRICS_HEADERS,
    config.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT,
    config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL,
    resourceAttributes
  )
  activeMetricsExporter = exporter

  const reader = new PeriodicMetricReader(
    exporter,
    config.OTEL_METRIC_EXPORT_INTERVAL,
    config.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE,
    config.OTEL_BSP_MAX_QUEUE_SIZE
  )

  const meterProvider = new MeterProvider({ reader })
  metrics.setGlobalMeterProvider(meterProvider)
}

function buildResourceAttributes (tags, { reportHostname, otelSemanticsEnabled, service, env, serviceVersion } = {}) {
  const attrs = {
    'telemetry.sdk.name': 'datadog',
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': VERSION,
  }
  if (service) attrs['service.name'] = service
  if (serviceVersion) attrs['service.version'] = serviceVersion
  if (env) attrs['deployment.environment.name'] = env
  if (reportHostname) attrs['host.name'] = os.hostname()

  if (!otelSemanticsEnabled) {
    if (tags?.['runtime-id']) attrs['datadog.runtime_id'] = tags['runtime-id']
    const processTagsObject = processTags.tagsObject
    if (processTagsObject) {
      for (const key of Object.keys(processTagsObject)) {
        attrs[`datadog.${key}`] = processTagsObject[key]
      }
    }
  }
  return attrs
}

/**
 * Builds the resource attributes for the OTLP span-stats exporter.
 * @param {import('../../config/config-base')} config - Tracer configuration instance
 * @returns {object} Resource attributes
 */
function buildStatsResourceAttributes (config) {
  return buildResourceAttributes(config.tags, {
    reportHostname: config.reportHostname,
    otelSemanticsEnabled: config.DD_TRACE_OTEL_SEMANTICS_ENABLED,
    service: config.service,
    env: config.env,
    serviceVersion: config.version,
  })
}

function createOtlpSpanStatsExporter (config) {
  const { OtlpStatsExporter } = require('./otlp_span_stats_exporter')
  const protocol = config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL || 'http/json'
  const resourceAttributes = buildStatsResourceAttributes(config)
  const exporter = new OtlpStatsExporter(
    config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    protocol,
    resourceAttributes,
    config.DD_TRACE_OTEL_SEMANTICS_ENABLED,
    config.service,
    config.OTEL_EXPORTER_OTLP_METRICS_HEADERS,
    config.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT
  )
  activeStatsExporter = exporter
  return exporter
}

/**
 * Recomputes and pushes fresh resource attributes (e.g. after a reseeded `runtime-id`) into
 * whichever OTel metrics exporters are currently active. No-op for any exporter that was never
 * initialized.
 *
 * @param {import('../../config/config-base')} config - Tracer configuration
 */
function refreshResourceAttributes (config) {
  activeMetricsExporter?.updateResourceAttributes(buildMetricsResourceAttributes(config))
  activeStatsExporter?.updateResourceAttributes(buildStatsResourceAttributes(config))
}

module.exports = {
  MeterProvider,
  initializeOpenTelemetryMetrics,
  buildResourceAttributes,
  createOtlpSpanStatsExporter,
  refreshResourceAttributes,
}

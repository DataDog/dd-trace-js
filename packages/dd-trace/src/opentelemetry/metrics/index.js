'use strict'

const os = require('os')

const { metrics } = require('@opentelemetry/api')

const { VERSION } = require('../../../../../version')
const processTags = require('../../process-tags')
const { registerTelemetryFlusher } = require('../../flush')
const MeterProvider = require('./meter_provider')
const PeriodicMetricReader = require('./periodic_metric_reader')
const OtlpHttpMetricExporter = require('./otlp_http_metric_exporter')

const RESERVED_TRACER_TAGS = new Set(['service', 'env', 'version', 'runtime_id', 'runtime-id'])
/**
 * @typedef {import('../../config')} Config
 */

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
 * Initializes OpenTelemetry Metrics support
 * @param {import('../../config/config-base')} config - Tracer configuration instance
 */
function initializeOpenTelemetryMetrics (config) {
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

  const exporter = new OtlpHttpMetricExporter(
    config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    config.OTEL_EXPORTER_OTLP_METRICS_HEADERS,
    config.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT,
    config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL,
    resourceAttributes
  )

  const reader = new PeriodicMetricReader(
    exporter,
    config.OTEL_METRIC_EXPORT_INTERVAL,
    config.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE,
    config.OTEL_BSP_MAX_QUEUE_SIZE
  )

  const meterProvider = new MeterProvider({ reader })
  metrics.setGlobalMeterProvider(meterProvider)
  // Include the final metric collection and export in lifecycle retention.
  registerTelemetryFlusher(done => meterProvider.forceFlush(done))
}

/**
 * @param {Record<string, unknown>} tags
 * @param {object} [options]
 * @param {boolean} [options.reportHostname]
 * @param {string} [options.service]
 * @param {string} [options.env]
 * @param {string} [options.serviceVersion]
 * @returns {import('@opentelemetry/api').Attributes}
 */
function buildResourceAttributes (tags, { reportHostname, service, env, serviceVersion } = {}) {
  const attrs = {
    'telemetry.sdk.name': 'datadog',
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': VERSION,
  }
  if (service) attrs['service.name'] = service
  if (serviceVersion) attrs['service.version'] = serviceVersion
  if (env) attrs['deployment.environment.name'] = env
  if (reportHostname) attrs['host.name'] = os.hostname()

  if (tags['runtime-id']) attrs['datadog.runtime_id'] = tags['runtime-id']
  const tracerTags = []
  for (const [key, value] of Object.entries(tags)) {
    const valueType = typeof value
    const supported = valueType === 'string' || valueType === 'boolean' ||
      (valueType === 'number' && Number.isFinite(value))
    if (!RESERVED_TRACER_TAGS.has(key) && supported) tracerTags.push(`${key}:${value}`)
  }
  if (tracerTags.length) attrs['datadog.tracer_tags'] = tracerTags
  // Mirrors the legacy v0.6/stats ProcessTags shape (buildProcessTags().tagsArray); keep both in sync.
  const processTagsArray = processTags.tagsArray
  if (processTagsArray.length) {
    attrs['datadog.process_tags'] = processTagsArray
  }
  return attrs
}

function createOtlpSpanStatsExporter (config) {
  const { OtlpStatsExporter } = require('./otlp_span_stats_exporter')
  const protocol = config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL || 'http/json'
  const resourceAttributes = buildResourceAttributes(config.tags, {
    reportHostname: config.reportHostname,
    service: config.service,
    env: config.env,
    serviceVersion: config.version,
  })
  return new OtlpStatsExporter(
    config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    protocol,
    resourceAttributes,
    config.OTEL_EXPORTER_OTLP_METRICS_HEADERS,
    config.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT
  )
}

module.exports = {
  MeterProvider,
  initializeOpenTelemetryMetrics,
  buildResourceAttributes,
  createOtlpSpanStatsExporter,
}

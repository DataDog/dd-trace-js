'use strict'

const os = require('os')

const { channel } = require('dc-polyfill')
const { metrics } = require('@opentelemetry/api')

const { VERSION } = require('../../../../../version')
const processTags = require('../../process-tags')
const MeterProvider = require('./meter_provider')
const PeriodicMetricReader = require('./periodic_metric_reader')
const OtlpHttpMetricExporter = require('./otlp_http_metric_exporter')

const identityRefreshChannel = channel('datadog:identity:refresh')

// Only one general-metrics exporter and one span-stats exporter are active at a time; each
// `initializeOpenTelemetryMetrics`/`createOtlpSpanStatsExporter` call replaces the previous
// subscription so restarts don't accumulate listeners.
let unsubscribeMetricsIdentityRefresh = null
let unsubscribeSpanStatsIdentityRefresh = null

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
 * Builds the resource attributes for the general OTel metrics exporter (service/version/env,
 * `config.tags` minus those three, and hostname when enabled). Shared by
 * `initializeOpenTelemetryMetrics()` and its identity-refresh handler so they can't drift apart.
 * @param {import('../../config/config-base')} config - Tracer configuration instance
 * @returns {object} Resource attributes
 */
function buildGeneralResourceAttributes (config) {
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
  const exporter = new OtlpHttpMetricExporter(
    config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    config.OTEL_EXPORTER_OTLP_METRICS_HEADERS,
    config.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT,
    config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL,
    buildGeneralResourceAttributes(config)
  )

  const reader = new PeriodicMetricReader(
    exporter,
    config.OTEL_METRIC_EXPORT_INTERVAL,
    config.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE,
    config.OTEL_BSP_MAX_QUEUE_SIZE
  )

  const meterProvider = new MeterProvider({ reader })
  metrics.setGlobalMeterProvider(meterProvider)

  unsubscribeMetricsIdentityRefresh?.()
  const onIdentityRefresh = () => exporter.updateResourceAttributes(buildGeneralResourceAttributes(config))
  identityRefreshChannel.subscribe(onIdentityRefresh)
  unsubscribeMetricsIdentityRefresh = () => identityRefreshChannel.unsubscribe(onIdentityRefresh)
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

function createOtlpSpanStatsExporter (config) {
  const { OtlpStatsExporter } = require('./otlp_span_stats_exporter')
  const protocol = config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL || 'http/json'
  const buildSpanStatsResourceAttributes = () => buildResourceAttributes(config.tags, {
    reportHostname: config.reportHostname,
    otelSemanticsEnabled: config.DD_TRACE_OTEL_SEMANTICS_ENABLED,
    service: config.service,
    env: config.env,
    serviceVersion: config.version,
  })
  const exporter = new OtlpStatsExporter(
    config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    protocol,
    buildSpanStatsResourceAttributes(),
    config.DD_TRACE_OTEL_SEMANTICS_ENABLED,
    config.service,
    config.OTEL_EXPORTER_OTLP_METRICS_HEADERS,
    config.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT
  )

  unsubscribeSpanStatsIdentityRefresh?.()
  const onIdentityRefresh = () => exporter.updateResourceAttributes(buildSpanStatsResourceAttributes())
  identityRefreshChannel.subscribe(onIdentityRefresh)
  unsubscribeSpanStatsIdentityRefresh = () => identityRefreshChannel.unsubscribe(onIdentityRefresh)

  return exporter
}

module.exports = {
  MeterProvider,
  initializeOpenTelemetryMetrics,
  buildResourceAttributes,
  createOtlpSpanStatsExporter,
}

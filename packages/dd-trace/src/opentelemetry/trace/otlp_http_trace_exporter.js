'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const { SAMPLING_PRIORITY_KEY } = require('../../constants')
const { AUTO_KEEP } = require('../../../../../ext/priority')
const OtlpTraceTransformer = require('./otlp_transformer')

/**
 * OtlpHttpTraceExporter exports DD-formatted spans via OTLP over HTTP (JSON or protobuf).
 *
 * This implementation follows the OTLP HTTP specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * It receives DD-formatted spans (from span_format.js), transforms them
 * to an OTLP ExportTraceServiceRequest in the configured encoding, and sends them to the
 * configured OTLP endpoint via HTTP POST.
 *
 * TODO: Add batch handling similar to the OpenTelemetry SDK Batch Processor
 * (https://opentelemetry.io/docs/specs/otel/trace/sdk/#batching-processor).
 * Currently each finished trace is sent as its own HTTP request, which is
 * unsuitable for high-traffic production environments. The config values
 * `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, and `OTEL_BSP_MAX_QUEUE_SIZE`
 * (OTEL_BSP_*) are already defined and should drive that implementation.
 *
 * @class OtlpHttpTraceExporter
 * @augments OtlpHttpExporterBase
 */
class OtlpHttpTraceExporter extends OtlpHttpExporterBase {
  #transformer

  /**
   * Creates a new OtlpHttpTraceExporter instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {Record<string, string>|undefined} headers - Additional HTTP headers parsed from the
   *   corresponding `OTEL_EXPORTER_OTLP_*_HEADERS` env by the MAP parser.
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   * @param {boolean} [otelTraceSemanticsEnabled] - When true, do not emit Datadog-only attributes as span attributes
   */
  constructor (url, headers, timeout, protocol, resourceAttributes, otelTraceSemanticsEnabled) {
    super(url, headers, timeout, protocol, 'traces', resourceAttributes)
    this.#transformer = new OtlpTraceTransformer(resourceAttributes, protocol, otelTraceSemanticsEnabled)
    // Expose the protocol actually used after transformer fallback (grpc -> http/protobuf) so
    // startup reporting describes the exporter rather than the requested protocol.
    this.protocol = this.#transformer.protocol
  }

  /**
   * Recomputes the resource attributes baked into the transformer (e.g. after a MicroVM clone
   * resume regenerates `runtime-id`).
   *
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   */
  updateResourceAttributes (resourceAttributes) {
    this.#transformer.updateResourceAttributes(resourceAttributes)
  }

  /**
   * Exports DD-formatted spans via OTLP over HTTP.
   *
   * @param {import('./otlp_transformer').DDFormattedSpan[]} spans - Array of DD-formatted spans to export
   */
  export (spans) {
    if (spans.length === 0) {
      return
    }

    // Drop unsampled traces — OTLP endpoints have no agent-side sampling.
    const priority = spans[0]?.metrics?.[SAMPLING_PRIORITY_KEY]
    if (priority !== undefined && priority < AUTO_KEEP) {
      return
    }

    const additionalTags = [`spans:${spans.length}`]
    this.recordTelemetry('otel.traces_export_attempts', 1, additionalTags)

    const payload = this.#transformer.transformSpans(spans)
    this.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this.recordTelemetry('otel.traces_export_successes', 1, additionalTags)
      }
    })
  }
}

module.exports = OtlpHttpTraceExporter

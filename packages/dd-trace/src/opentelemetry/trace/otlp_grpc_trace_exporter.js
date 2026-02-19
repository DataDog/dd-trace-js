'use strict'

const OtlpGrpcExporterBase = require('../otlp/otlp_grpc_exporter_base')
const OtlpTraceTransformer = require('./otlp_transformer')

const GRPC_TRACE_SERVICE_PATH = '/opentelemetry.proto.collector.trace.v1.TraceService/Export'

/**
 * OtlpGrpcTraceExporter exports DD-formatted spans via OTLP over gRPC.
 *
 * This implementation follows the OTLP/gRPC specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlpgrpc
 *
 * It receives DD-formatted spans (from span_format.js), transforms them
 * to OTLP ExportTraceServiceRequest protobuf format, and sends them to the
 * configured OTLP endpoint via gRPC (HTTP/2).
 *
 * @class OtlpGrpcTraceExporter
 * @augments OtlpGrpcExporterBase
 */
class OtlpGrpcTraceExporter extends OtlpGrpcExporterBase {
  /**
   * Creates a new OtlpGrpcTraceExporter instance.
   *
   * @param {string} url - OTLP gRPC endpoint URL (e.g. http://localhost:4317)
   * @param {string} headers - Additional headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   */
  constructor (url, headers, timeout, resourceAttributes) {
    super(url, headers, timeout, GRPC_TRACE_SERVICE_PATH, 'traces')
    this.transformer = new OtlpTraceTransformer(resourceAttributes, 'http/protobuf')
  }

  /**
   * Exports DD-formatted spans via OTLP over gRPC.
   *
   * @param {import('./otlp_transformer').DDFormattedSpan[]} spans - Array of DD-formatted spans to export
   * @returns {void}
   */
  export (spans) {
    if (spans.length === 0) {
      return
    }

    const additionalTags = [`spans:${spans.length}`]
    this.recordTelemetry('otel.traces_export_attempts', 1, additionalTags)

    const payload = this.transformer.transformSpans(spans)
    this.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this.recordTelemetry('otel.traces_export_successes', 1, additionalTags)
      }
    })
  }
}

module.exports = OtlpGrpcTraceExporter

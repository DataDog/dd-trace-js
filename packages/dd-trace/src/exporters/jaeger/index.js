const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')
const { BatchSpanProcessor } = require('@opentelemetry/tracing')
const URL = require('url').URL

class JaegerExporterProxy {
  constructor ({ url, hostname, port, service, flushInterval }, sampler) {
    this._url = url ? new URL(url) : new URL(`http://${hostname || 'localhost'}:${port}`)
    this._exporter = new JaegerExporter({
      host: hostname,
      port,
      serviceName: service,
      endpoint: this._url.toString()
    })
    // in the DD implementation
    // the batching resposability belongs in the exporter
    // while in the open tracing implementation
    // the span processor does the batching and the exporter just sends
    // the data
    // to keep this compatible
    // we are gonna have an internal processor
    this._processor = new BatchSpanProcessor(this._exporter, {
      scheduledDelayMillis: flushInterval,
      exportTimeoutMillis: 30000,
      maxQueueSize: 2048,
      maxExportBatchSize: 512
    })
  }

  export (spans) {
    spans.map(formatSpan).forEach((span) => this._processor.onEnd(span))
  }
}
module.exports = JaegerExporterProxy

function formatSpan (span) {
  const context = span.context()
  return {
    spanContext: {
      traceId: context.traceId,
      spanId: context.spanId
    },
    attributes: context._tags,
    parentSpanId: span.parentSpanId,
    name: span.name,
    duration: span.duration,
    startTime: span.startTime,
    links: span.links,
    resource: span.resource,
    ended: span.ended,
    events: span.events,
    status: span.status,
    kind: span.kind
  }
}

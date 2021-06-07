const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')
const { BatchSpanProcessor } = require('@opentelemetry/tracing')
const URL = require('url').URL
const SPAN_STATUS_CODE = require('../../../../../ext/status')
const TAGS = require('../../../../../ext/tags')
const KINDS = require('../../../../../ext/kinds')

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
    spans.map(transformToOtel).forEach((span) => this._processor.onEnd(span))
  }
}
module.exports = JaegerExporterProxy

function transformToOtel (span) {
  const parentSpanId = span.parent_id && span.parent_id.toString(10)
  const formatted = {
    spanContext: {
      traceId: span.trace_id.toString(10),
      spanId: span.span_id.toString(10)
    },
    parentSpanId: parentSpanId !== '0' ? parentSpanId : undefined,
    name: span.name,
    duration: numberToHrtime(span.duration),
    startTime: numberToHrtime(span.start),
    links: [],
    resource: {
      attributes: { 'resource.name': span.resource }
    },
    events: [],
    status: {
      code: span.error ? SPAN_STATUS_CODE.ERROR : SPAN_STATUS_CODE.OK,
      message: span.meta['error.msg']
    },
    metrics: span.metrics,
    attributes: span.meta,
    kind: getKind(span)
  }
  return formatted
}

function numberToHrtime (epochNanoseconds) {
  const NANOSECOND_DIGITS = 9
  const SECOND_TO_NANOSECONDS = Math.pow(10, NANOSECOND_DIGITS)
  const epochSeconds = epochNanoseconds / 1e9
  // Decimals only.
  const seconds = Math.trunc(epochSeconds)
  // Round sub-nanosecond accuracy to nanosecond.
  const nanos = Number((epochSeconds - seconds).toFixed(NANOSECOND_DIGITS)) * SECOND_TO_NANOSECONDS
  return [seconds, nanos]
}

function getKind (span) {
  switch (span.meta[TAGS.SPAN_KIND]) {
    case KINDS.CLIENT: {
      return 2
    }
    case KINDS.SERVER: {
      return 1
    }
    case KINDS.PRODUCER: {
      return 3
    }
    case KINDS.CONSUMER: {
      return 4
    }
    default: {
      return 0
    }
  }
}

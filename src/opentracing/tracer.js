'use strict'

const opentracing = require('opentracing')
const url = require('url')
const Tracer = opentracing.Tracer
const Span = require('./span')
const Recorder = require('../recorder')
const Sampler = require('../sampler')
const TextMapPropagator = require('./propagation/text_map')
const HttpPropagator = require('./propagation/http')
const BinaryPropagator = require('./propagation/binary')

class DatadogTracer extends Tracer {
  constructor (config) {
    super()

    const service = config.service
    const hostname = config.hostname || 'localhost'
    const port = config.port || 8126
    const protocol = config.protocol || 'http'
    const agentUrl = url.parse(`${protocol}://${hostname}:${port}`)
    const flushInterval = config.flushInterval || 2000
    const bufferSize = config.bufferSize || 1000

    this._service = service
    this._recorder = new Recorder(agentUrl, flushInterval, bufferSize)
    this._recorder.init()
    this._sampler = new Sampler()
    this._propagators = {
      [opentracing.FORMAT_TEXT_MAP]: new TextMapPropagator(),
      [opentracing.FORMAT_HTTP_HEADERS]: new HttpPropagator(),
      [opentracing.FORMAT_BINARY]: new BinaryPropagator()
    }
  }

  _startSpan (name, fields) {
    return new Span(this, {
      operationName: fields.operationName || name,
      parent: getParent(fields.references),
      tags: fields.tags,
      startTime: fields.startTime
    })
  }

  _record (span) {
    this._recorder.record(span)
  }

  _inject (spanContext, format, carrier) {
    this._propagators[format].inject(spanContext, carrier)
    return this
  }

  _extract (format, carrier) {
    return this._propagators[format].extract(carrier)
  }

  _isSampled (span) {
    return this._sampler.isSampled(span)
  }
}

function getParent (references) {
  let parent = null

  if (references) {
    for (let i = 0; i < references.length; i++) {
      const ref = references[i]
      if (ref.type() === opentracing.REFERENCE_CHILD_OF) {
        parent = ref.referencedContext()
        break
      } else if (ref.type() === opentracing.REFERENCE_FOLLOWS_FROM) {
        if (!parent) {
          parent = ref.referencedContext()
        }
      }
    }
  }

  return parent
}

module.exports = DatadogTracer

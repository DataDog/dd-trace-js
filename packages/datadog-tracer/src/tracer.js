'use strict'

const { Sampler } = require('./sampler')
const { Writer } = require('./writer')
const { Span } = require('./span')
const { TextMapPropagator } = require('./propagators/text_map')

const { DD_SERVICE, DD_ENV, RATE_LIMIT, SAMPLE_RATE } = process.env

const sampleRate = parseFloat(SAMPLE_RATE || '1')
const rateLimit = parseFloat(RATE_LIMIT || '100')

class Tracer {
  constructor () {
    this.config = {
      service: DD_SERVICE || 'node',
      env: DD_ENV
    }

    this._writer = new Writer()
    this._sampler = new Sampler({ rateLimit, sampleRate })
    this._propagators = {
      text_map: [
        new TextMapPropagator()
      ]
    }
  }

  startSpan (name, resource, options) {
    return new Span(this, name, resource, options)
  }

  inject (span, format, carrier) {
    const propagators = this._propagators[format]

    if (!propagators) return

    this._sampler.sample(span)

    for (const propagator of propagators) {
      propagator.inject(span, carrier)
    }
  }

  extract (format, carrier) {
    const propagators = this._propagators[format]

    if (!propagators) return

    for (const propagator of propagators) {
      const spanContext = propagator.extract(carrier)

      if (spanContext) return spanContext
    }

    return null
  }

  export (trace) {
    this._sampler.sample(trace.spans[0]) // TODO: should this be done here?
    this._writer.write(trace.spans)
  }

  flush (done) {
    this._writer.flush((err, res) => {
      if (!err && res.rate_by_service) {
        this._sampler.update(res.rate_by_service)
      }

      done && done()
    })
  }
}

const tracer = new Tracer()

process.once('beforeExit', () => tracer.flush()) // TODO: move out or timer in

module.exports = { tracer }

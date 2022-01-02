'use strict'

const { Sampler } = require('./sampler')
const { Span } = require('./span')
const { Config } = require('./config')
const { TextMapPropagator } = require('./propagators/text_map')
const { LogPropagator } = require('./propagators/log')

class Tracer {
  constructor (options) {
    const config = this.config = new Config(options)

    this._sampler = new Sampler(config)
    this._exporter = this._getExporter()
    this._propagators = {
      text_map: new TextMapPropagator(config),
      log: new LogPropagator(config)
    }
  }

  configure (options) {
    this.config.update(options)
  }

  startSpan (name, options) {
    const span = new Span(this, name, options)

    span.trace.spans.push(span)

    return span
  }

  inject (span, format, carrier) {
    const propagator = this._propagators[format]

    if (!propagator) return

    this._sampler.sample(span)

    propagator.inject(span, carrier)
  }

  extract (format, carrier) {
    const propagator = this._propagators[format]

    if (!propagator) return null

    return propagator.extract(carrier)
  }

  process (span) {
    const trace = span.trace

    if (trace.started === trace.finished) {
      this._sampler.sample(span)
      this._exporter.add(trace.spans)

      trace.spans = []
    }
  }

  flush (done) {
    this._exporter.flush(done)
  }

  _getExporter () {
    switch (this.config.exporter) {
      case 'log': {
        const { LogExporter } = require('./exporters/log')
        return new LogExporter(this.config)
      }
      default: {
        const { AgentExporter } = require('./exporters/agent')
        return new AgentExporter(this.config, this._sampler)
      }
    }
  }
}

const tracer = new Tracer()

module.exports = { tracer }

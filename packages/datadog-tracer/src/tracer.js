'use strict'

const { Sampler } = require('./sampler')
const { Span } = require('./span')
const { Config } = require('./config')
const { TextMapPropagator } = require('./propagators/text_map')
const { LogPropagator } = require('./propagators/log')

// TODO: consider moving the exporters out
// TODO: add an option to pass an exporter
// TODO: add an option to pass a custom propagator

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
    const { flushMinSpans } = this.config
    const trace = span.trace
    const unfinished = []
    const finished = []

    if (trace.started === trace.finished || trace.finished >= flushMinSpans) {
      this._sampler.sample(span)

      for (const span of trace.spans) {
        if (span.duration > 0) {
          finished.push(span)
        } else {
          unfinished.push(span)
        }
      }

      this._exporter.add(finished)

      trace.spans = unfinished
      trace.started = unfinished.length
      trace.finished = 0
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

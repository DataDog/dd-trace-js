'use strict'

const DatadogTracer = require('../opentracing/tracer')
const DatadogCollectorSpan = require('./span')
const { CollectorExporter } = require('../collector/exporter')

class DatadogCollectorTracer extends DatadogTracer {
  constructor (config) {
    super(config)

    this._collector = new CollectorExporter(config)
    this._collector.start()
  }

  _initSpan (...args) {
    return new DatadogCollectorSpan(...args)
  }

  _setUrl (url) {
    this._collector.setUrl(url)
  }
}

module.exports = DatadogCollectorTracer

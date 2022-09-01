'use strict'

const os = require('os')
const Span = require('./span')
const SpanProcessor = require('../span_processor')
const PrioritySampler = require('../priority_sampler')
const TextMapPropagator = require('./propagation/text_map')
const HttpPropagator = require('./propagation/http')
const BinaryPropagator = require('./propagation/binary')
const LogPropagator = require('./propagation/log')
const formats = require('../../../../ext/formats')

const log = require('../log')
const metrics = require('../metrics')
const getExporter = require('../exporter')
const SpanContext = require('./span_context')

const REFERENCE_CHILD_OF = 'child_of'
const REFERENCE_FOLLOWS_FROM = 'follows_from'

class DatadogTracer {
  constructor (config) {
    const Exporter = getExporter(config.experimental.exporter)

    this._service = config.service
    this._version = config.version
    this._env = config.env
    this._tags = config.tags
    this._logInjection = config.logInjection
    this._debug = config.debug
    this._prioritySampler = new PrioritySampler(config.env, config.sampler)
    this._exporter = new Exporter(config, this._prioritySampler)
    this._processor = new SpanProcessor(this._exporter, this._prioritySampler, config)
    this._url = this._exporter._url
    this._enableGetRumData = config.experimental.enableGetRumData
    this._propagators = {
      [formats.TEXT_MAP]: new TextMapPropagator(config),
      [formats.HTTP_HEADERS]: new HttpPropagator(config),
      [formats.BINARY]: new BinaryPropagator(config),
      [formats.LOG]: new LogPropagator(config)
    }
    if (config.reportHostname) {
      this._hostname = os.hostname()
    }
  }

  startSpan (name, options = {}) {
    const parent = options.childOf
      ? getContext(options.childOf)
      : getParent(options.references)

    const tags = {
      'service.name': this._service
    }

    const span = new Span(this, this._processor, this._prioritySampler, {
      operationName: options.operationName || name,
      parent,
      tags,
      startTime: options.startTime,
      hostname: this._hostname
    }, this._debug)

    span.addTags(this._tags)
    span.addTags(options.tags)

    return span
  }

  inject (spanContext, format, carrier) {
    if (spanContext instanceof Span) {
      spanContext = spanContext.context()
    }

    try {
      this._prioritySampler.sample(spanContext)
      this._propagators[format].inject(spanContext, carrier)
    } catch (e) {
      log.error(e)
      metrics.increment('datadog.tracer.node.inject.errors', true)
    }
  }

  extract (format, carrier) {
    try {
      return this._propagators[format].extract(carrier)
    } catch (e) {
      log.error(e)
      metrics.increment('datadog.tracer.node.extract.errors', true)
      return null
    }
  }
}

function getContext (spanContext) {
  if (spanContext instanceof Span) {
    spanContext = spanContext.context()
  }

  if (!(spanContext instanceof SpanContext)) {
    spanContext = null
  }

  return spanContext
}

function getParent (references = []) {
  let parent = null

  for (let i = 0; i < references.length; i++) {
    const ref = references[i]
    const type = ref.type()

    if (type === REFERENCE_CHILD_OF) {
      parent = ref.referencedContext()
      break
    } else if (type === REFERENCE_FOLLOWS_FROM) {
      if (!parent) {
        parent = ref.referencedContext()
      }
    }
  }

  return parent
}

module.exports = DatadogTracer

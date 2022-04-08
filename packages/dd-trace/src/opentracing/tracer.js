'use strict'

const opentracing = require('opentracing')
const os = require('os')
const Tracer = opentracing.Tracer
const Reference = opentracing.Reference
const Span = require('./span')
const SpanContext = require('./span_context')
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

const REFERENCE_CHILD_OF = opentracing.REFERENCE_CHILD_OF
const REFERENCE_FOLLOWS_FROM = opentracing.REFERENCE_FOLLOWS_FROM

class DatadogTracer extends Tracer {
  constructor (config) {
    super()

    const Exporter = getExporter(config.experimental.exporter)

    this._service = config.service
    this._version = config.version
    this._env = config.env
    this._tags = config.tags
    this._logInjection = config.logInjection
    this._debug = config.debug
    this._prioritySampler = new PrioritySampler(config.env, config.experimental.sampler)
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

  _startSpan (name, fields) {
    const reference = getParent(fields.references)
    const parent = reference && reference.referencedContext()
    return this._startSpanInternal(name, fields, parent)
  }

  _startSpanInternal (name, fields = {}, parent) {
    const tags = {
      'service.name': this._service
    }

    const span = new Span(this, this._processor, this._prioritySampler, {
      operationName: fields.operationName || name,
      parent,
      tags,
      startTime: fields.startTime,
      hostname: this._hostname
    }, this._debug)

    span.addTags(this._tags)
    span.addTags(fields.tags)

    return span
  }

  _inject (spanContext, format, carrier) {
    try {
      this._prioritySampler.sample(spanContext)
      this._propagators[format].inject(spanContext, carrier)
    } catch (e) {
      log.error(e)
      metrics.increment('datadog.tracer.node.inject.errors', true)
    }

    return this
  }

  _extract (format, carrier) {
    try {
      return this._propagators[format].extract(carrier)
    } catch (e) {
      log.error(e)
      metrics.increment('datadog.tracer.node.extract.errors', true)
      return null
    }
  }
}

function getParent (references = []) {
  let parent = null

  for (let i = 0; i < references.length; i++) {
    const ref = references[i]

    if (!(ref instanceof Reference)) {
      log.error(() => `Expected ${ref} to be an instance of opentracing.Reference`)
      continue
    }

    const spanContext = ref.referencedContext()
    const type = ref.type()

    if (spanContext && !(spanContext instanceof SpanContext)) {
      log.error(() => `Expected ${spanContext} to be an instance of SpanContext`)
      continue
    }

    if (type === REFERENCE_CHILD_OF) {
      parent = ref
      break
    } else if (type === REFERENCE_FOLLOWS_FROM) {
      if (!parent) {
        parent = ref
      }
    }
  }

  return parent
}

module.exports = DatadogTracer

'use strict'

const opentracing = require('opentracing')
const Tracer = opentracing.Tracer
const Reference = opentracing.Reference
const Span = require('./span')
const SpanContext = require('./span_context')
const Writer = require('../writer')
const Recorder = require('../recorder')
const Sampler = require('../sampler')
const PrioritySampler = require('../priority_sampler')
const TextMapPropagator = require('./propagation/text_map')
const HttpPropagator = require('./propagation/http')
const BinaryPropagator = require('./propagation/binary')
const log = require('../log')

class DatadogTracer extends Tracer {
  constructor (config) {
    super()

    log.use(config.logger)
    log.toggle(config.debug)

    this._service = config.service
    this._url = config.url
    this._env = config.env
    this._tags = config.tags
    this._prioritySampler = new PrioritySampler(config.env)
    this._writer = new Writer(this._prioritySampler, config.url, config.bufferSize)
    this._recorder = new Recorder(this._writer, config.flushInterval)
    this._recorder.init()
    this._sampler = new Sampler(config.sampleRate)
    this._propagators = {
      [opentracing.FORMAT_TEXT_MAP]: new TextMapPropagator(),
      [opentracing.FORMAT_HTTP_HEADERS]: new HttpPropagator(),
      [opentracing.FORMAT_BINARY]: new BinaryPropagator()
    }
  }

  _startSpan (name, fields) {
    const tags = {
      'resource.name': name
    }

    tags['service.name'] = this._service

    if (this._env) {
      tags.env = this._env
    }

    return new Span(this, this._recorder, this._sampler, this._prioritySampler, {
      operationName: fields.operationName || name,
      parent: getParent(fields.references),
      tags: Object.assign(tags, this._tags, fields.tags),
      startTime: fields.startTime
    })
  }

  _inject (spanContext, format, carrier) {
    try {
      this._prioritySampler.sample(spanContext)
      this._propagators[format].inject(spanContext, carrier)
    } catch (e) {
      log.error(e)
    }

    return this
  }

  _extract (format, carrier) {
    try {
      return this._propagators[format].extract(carrier)
    } catch (e) {
      log.error(e)
      return null
    }
  }
}

function getParent (references) {
  let parent = null

  if (references) {
    for (let i = 0; i < references.length; i++) {
      const ref = references[i]

      if (!(ref instanceof Reference)) {
        log.error(() => `Expected ${ref} to be an instance of opentracing.Reference`)
        break
      }

      const spanContext = ref.referencedContext()

      if (!(spanContext instanceof SpanContext)) {
        log.error(() => `Expected ${spanContext} to be an instance of SpanContext`)
        break
      }

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

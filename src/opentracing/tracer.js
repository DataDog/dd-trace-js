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
const LogPropagator = require('./propagation/log')
const NoopSpan = require('../noop/span')
const formats = require('../../ext/formats')
const log = require('../log')
const constants = require('../constants')
const platform = require('../platform')

const REFERENCE_NOOP = constants.REFERENCE_NOOP
const REFERENCE_CHILD_OF = opentracing.REFERENCE_CHILD_OF
const REFERENCE_FOLLOWS_FROM = opentracing.REFERENCE_FOLLOWS_FROM

class DatadogTracer extends Tracer {
  constructor (config) {
    super()

    log.use(config.logger)
    log.toggle(config.debug)

    this._noopSpan = new NoopSpan(this)
    this._service = config.service
    this._url = config.url
    this._env = config.env
    this._tags = config.tags
    this._logInjection = config.logInjection
    this._analytics = config.analytics
    this._prioritySampler = new PrioritySampler(config.env)
    this._writer = new Writer(this._prioritySampler, config.url)
    this._recorder = new Recorder(this._writer, config.flushInterval)
    this._recorder.init()
    this._sampler = new Sampler(config.sampleRate)
    this._propagators = {
      [formats.TEXT_MAP]: new TextMapPropagator(),
      [formats.HTTP_HEADERS]: new HttpPropagator(),
      [formats.BINARY]: new BinaryPropagator(),
      [formats.LOG]: new LogPropagator()
    }
    if (config.reportHostname) {
      this._hostname = platform.hostname()
    }
  }

  _startSpan (name, fields) {
    const references = getReferences(fields.references)
    const reference = getParent(references)
    const type = reference && reference.type()
    const parent = reference && reference.referencedContext()
    const noopSpan = this._noopSpan

    if (type === REFERENCE_NOOP) return noopSpan
    if (parent && parent === noopSpan.context()) return noopSpan
    if (!parent && !this._sampler.isSampled()) return noopSpan

    const tags = {
      'service.name': this._service
    }

    if (this._env) {
      tags.env = this._env
    }

    const span = new Span(this, this._recorder, this._sampler, this._prioritySampler, {
      operationName: fields.operationName || name,
      parent,
      tags: Object.assign(tags, this._tags, fields.tags),
      startTime: fields.startTime,
      hostname: this._hostname
    })

    return span
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

function getReferences (references) {
  if (!references) return []

  return references.filter(ref => {
    if (!(ref instanceof Reference)) {
      log.error(() => `Expected ${ref} to be an instance of opentracing.Reference`)
      return false
    }

    const spanContext = ref.referencedContext()

    if (ref.type() !== REFERENCE_NOOP && !(spanContext instanceof SpanContext)) {
      log.error(() => `Expected ${spanContext} to be an instance of SpanContext`)
      return false
    }

    return true
  })
}

function getParent (references) {
  let parent = null

  for (let i = 0; i < references.length; i++) {
    const ref = references[i]
    const type = ref.type()

    if (type === REFERENCE_CHILD_OF || type === REFERENCE_NOOP) {
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

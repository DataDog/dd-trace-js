'use strict'

const opentracing = require('opentracing')
const Tracer = opentracing.Tracer
const Reference = opentracing.Reference
const { tracer } = require('../../../datadog-tracer')
const Span = require('./span')
const SpanContext = require('./span_context')

const log = require('../log')
const metrics = require('../metrics')

const REFERENCE_CHILD_OF = opentracing.REFERENCE_CHILD_OF
const REFERENCE_FOLLOWS_FROM = opentracing.REFERENCE_FOLLOWS_FROM

class DatadogTracer extends Tracer {
  constructor (config) {
    super()

    this._service = config.service
    this._env = config.env
    this._version = config.version
    this._logInjection = config.logInjection
    this._debug = config.debug
    this._enableGetRumData = config.experimental.enableGetRumData
    this._url = config.url || new URL(`http://${config.hostname || 'localhost'}:${config.port || 8126}`)
  }

  _startSpan (name, fields) {
    const reference = getParent(fields.references)
    const parent = reference && reference.referencedContext()
    const childOf = parent ? parent._span : null

    name = fields.operationName || name

    const internalSpan = tracer.startSpan(name, { childOf })
    const span = new Span(this, internalSpan)

    span.addTags(fields.tags)

    return span
  }

  _inject (spanContext, format, carrier) {
    if (!spanContext) return this
    if (format === 'http_headers') {
      format = 'text_map'
    }

    const span = spanContext.trace ? spanContext : spanContext._span

    try {
      tracer.inject(span, format, carrier)
    } catch (e) {
      log.error(e)
      metrics.increment('datadog.tracer.node.inject.errors', true)
    }

    return this
  }

  _extract (format, carrier) {
    if (format === 'http_headers') {
      format = 'text_map'
    }

    try {
      const internalSpan = tracer.extract(format, carrier)
      const spanContext = new SpanContext(internalSpan)
      return spanContext
    } catch (e) {
      log.error(e)
      metrics.increment('datadog.tracer.node.extract.errors', true)
      return null
    }
  }

  _flush (done = () => {}) {
    tracer.flush(() => done())
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

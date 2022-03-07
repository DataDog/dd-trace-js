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

    const span = tracer.startSpan(name, { childOf })

    span.addTags(fields.tags)

    return new Span(this, span)
  }

  _inject (spanContext, format, carrier) {
    if (!spanContext) return this

    try {
      tracer.inject(spanContext._span, format, carrier)
    } catch (e) {
      log.error(e)
      metrics.increment('datadog.tracer.node.inject.errors', true)
    }

    return this
  }

  _extract (format, carrier) {
    try {
      return tracer.extract(format, carrier)
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

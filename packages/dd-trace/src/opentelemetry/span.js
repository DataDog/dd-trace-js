'use strict'

const api = require('@opentelemetry/api')

const { performance } = require('perf_hooks')
const { timeOrigin } = performance

const { timeInputToHrTime } = require('@opentelemetry/core')

const tracer = require('../../')
const DatadogSpan = require('../opentracing/span')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../constants')
const { SERVICE_NAME, RESOURCE_NAME } = require('../../../../ext/tags')
const kinds = require('../../../../ext/kinds')

const SpanContext = require('./span_context')

// The one built into OTel rounds so we lose sub-millisecond precision.
function hrTimeToMilliseconds (time) {
  return time[0] * 1e3 + time[1] / 1e6
}

function isTimeInput (startTime) {
  if (typeof startTime === 'number') {
    return true
  }
  if (startTime instanceof Date) {
    return true
  }
  if (Array.isArray(startTime) && startTime.length === 2 &&
      typeof startTime[0] === 'number' && typeof startTime[1] === 'number') {
    return true
  }
  return false
}

const spanKindNames = {
  [api.SpanKind.INTERNAL]: kinds.INTERNAL,
  [api.SpanKind.SERVER]: kinds.SERVER,
  [api.SpanKind.CLIENT]: kinds.CLIENT,
  [api.SpanKind.PRODUCER]: kinds.PRODUCER,
  [api.SpanKind.CONSUMER]: kinds.CONSUMER
}

/**
 * Several of these attributes are not yet supported by the Node.js OTel API.
 * We check for old equivalents where we can, but not all had equivalents.
 */
function spanNameMapper (spanName, kind, attributes) {
  if (spanName) return spanName

  const opName = attributes['operation.name']
  if (opName) return opName

  const { INTERNAL, SERVER, CLIENT } = api.SpanKind

  // HTTP server and client requests
  // TODO: Drop http.method when http.request.method is supported.
  for (const key of ['http.method', 'http.request.method']) {
    if (key in attributes) {
      if (kind === SERVER) {
        return 'http.server.request'
      }
      if (kind === CLIENT) {
        return 'http.client.request'
      }
    }
  }

  // Databases
  const dbSystem = attributes['db.system']
  if (dbSystem && kind === CLIENT) {
    return `${dbSystem}.query`
  }

  // Messaging
  const msgSys = attributes['messaging.system']
  const msgOp = attributes['messaging.operation']
  if (msgSys && msgOp && kind !== INTERNAL) {
    return `${msgSys}.${msgOp}`
  }

  // RPC (and AWS)
  const rpcSystem = attributes['rpc.system']
  if (rpcSystem) {
    if (kind === CLIENT) {
      return rpcSystem === 'aws-api'
        ? `aws.${attributes['rpc.service'] || 'client'}.request`
        : `${rpcSystem}.client.request`
    }
    if (kind === SERVER) {
      return `${rpcSystem}.server.request`
    }
  }

  // FaaS
  const faasProvider = attributes['faas.invoked_provider']
  const faasName = attributes['faas.invoked_name']
  const faasTrigger = attributes['faas.trigger']
  if (kind === CLIENT && faasProvider && faasName) {
    return `${faasProvider}.${faasName}.invoke`
  }
  if (kind === SERVER && faasTrigger) {
    return `${faasTrigger}.invoke`
  }

  // GraphQL
  // NOTE: Not part of Semantic Convention spec yet, but is used in the GraphQL
  // integration.
  const isGraphQL = 'graphql.operation.type' in attributes
  if (isGraphQL) return 'graphql.server.request'

  // Network
  // TODO: Doesn't exist yet. No equivalent.
  const protocol = attributes['network.protocol.name']
  const protocolPrefix = protocol ? `${protocol}.` : ''
  if (kind === SERVER) return `${protocolPrefix}server.request`
  if (kind === CLIENT) return `${protocolPrefix}client.request`

  // If all else fails, default to stringified span.kind.
  return spanKindNames[kind]
}

class Span {
  constructor (
    parentTracer,
    context,
    spanName,
    spanContext,
    kind,
    links = [],
    timeInput,
    attributes
  ) {
    const { _tracer } = tracer

    const hrStartTime = timeInputToHrTime(timeInput || (performance.now() + timeOrigin))
    const startTime = hrTimeToMilliseconds(hrStartTime)

    this._ddSpan = new DatadogSpan(_tracer, _tracer._processor, _tracer._prioritySampler, {
      operationName: spanNameMapper(spanName, kind, attributes),
      context: spanContext._ddContext,
      startTime,
      hostname: _tracer._hostname,
      integrationName: 'otel',
      tags: {
        [SERVICE_NAME]: _tracer._service,
        [RESOURCE_NAME]: spanName
      },
      links
    }, _tracer._debug)

    if (attributes) {
      this.setAttributes(attributes)
    }

    this._parentTracer = parentTracer
    this._context = context

    this._hasStatus = false

    // NOTE: Need to grab the value before setting it on the span because the
    // math for computing opentracing timestamps is apparently lossy...
    this.startTime = hrStartTime
    this.kind = kind
    this._spanProcessor.onStart(this, context)
  }

  get parentSpanId () {
    const { _parentId } = this._ddSpan.context()
    return _parentId && _parentId.toString(16)
  }

  // Expected by OTel
  get resource () {
    return this._parentTracer.resource
  }

  get instrumentationLibrary () {
    return this._parentTracer.instrumentationLibrary
  }

  get _spanProcessor () {
    return this._parentTracer.getActiveSpanProcessor()
  }

  get name () {
    return this._ddSpan.context()._name
  }

  spanContext () {
    return new SpanContext(this._ddSpan.context())
  }

  setAttribute (key, value) {
    if (key === 'http.response.status_code') {
      this._ddSpan.setTag('http.status_code', value.toString())
    }

    this._ddSpan.setTag(key, value)
    return this
  }

  setAttributes (attributes) {
    if ('http.response.status_code' in attributes) {
      attributes['http.status_code'] = attributes['http.response.status_code'].toString()
    }

    this._ddSpan.addTags(attributes)
    return this
  }

  addLink (context, attributes) {
    // extract dd context
    const ddSpanContext = context._ddContext
    this._ddSpan.addLink(ddSpanContext, attributes)
    return this
  }

  setStatus ({ code, message }) {
    if (!this.ended && !this._hasStatus && code) {
      this._hasStatus = true
      if (code === 2) {
        this._ddSpan.addTags({
          [ERROR_MESSAGE]: message
        })
      }
    }
    return this
  }

  updateName (name) {
    if (!this.ended) {
      this._ddSpan.setOperationName(name)
    }
    return this
  }

  end (timeInput) {
    if (this.ended) {
      api.diag.error('You can only call end() on a span once.')
      return
    }

    const hrEndTime = timeInputToHrTime(timeInput || (performance.now() + timeOrigin))
    const endTime = hrTimeToMilliseconds(hrEndTime)

    this._ddSpan.finish(endTime)
    this._spanProcessor.onEnd(this)
  }

  isRecording () {
    return this.ended === false
  }

  addEvent (name, attributesOrStartTime, startTime) {
    startTime = attributesOrStartTime && isTimeInput(attributesOrStartTime) ? attributesOrStartTime : startTime
    const hrStartTime = timeInputToHrTime(startTime || (performance.now() + timeOrigin))
    startTime = hrTimeToMilliseconds(hrStartTime)

    this._ddSpan.addEvent(name, attributesOrStartTime, startTime)
    return this
  }

  recordException (exception, timeInput) {
    // HACK: identifier is added so that trace.error remains unchanged after a call to otel.recordException
    this._ddSpan.addTags({
      [ERROR_TYPE]: exception.name,
      [ERROR_MESSAGE]: exception.message,
      [ERROR_STACK]: exception.stack,
      doNotSetTraceError: true
    })
    const attributes = {}
    if (exception.message) attributes['exception.message'] = exception.message
    if (exception.type) attributes['exception.type'] = exception.type
    if (exception.escaped) attributes['exception.escaped'] = exception.escaped
    if (exception.stack) attributes['exception.stacktrace'] = exception.stack
    this.addEvent(exception.name, attributes, timeInput)
  }

  get duration () {
    return this._ddSpan._duration
  }

  get ended () {
    return typeof this.duration !== 'undefined'
  }
}

module.exports = Span

'use strict'

const { performance } = require('perf_hooks')
const api = require('@opentelemetry/api')

const { timeOrigin } = performance

const { timeInputToHrTime } = require('../../../../vendor/dist/@opentelemetry/core')

const tracer = require('../../')
const DatadogSpan = require('../opentracing/span')
const { SERVICE_NAME, RESOURCE_NAME, SPAN_KIND } = require('../../../../ext/tags')
const kinds = require('../../../../ext/kinds')

const id = require('../id')
const BridgeSpanBase = require('./bridge-span-base')
const SpanContext = require('./span_context')
const { setOtelOperationName } = require('./span-helpers')

const spanKindNames = {
  [api.SpanKind.INTERNAL]: kinds.INTERNAL,
  [api.SpanKind.SERVER]: kinds.SERVER,
  [api.SpanKind.CLIENT]: kinds.CLIENT,
  [api.SpanKind.PRODUCER]: kinds.PRODUCER,
  [api.SpanKind.CONSUMER]: kinds.CONSUMER,
}

/**
 * The OTel-shipped `hrTimeToMilliseconds` rounds, dropping sub-millisecond precision we want.
 *
 * @param {[number, number]} hrTime
 */
function hrTimeToMilliseconds (hrTime) {
  return hrTime[0] * 1e3 + hrTime[1] / 1e6
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

/**
 * OTel-bridge span backed by a `DatadogSpan`. `Tracer` constructs these on the OTel API
 * surface; the underlying DD span carries the lifecycle.
 */
class Span extends BridgeSpanBase {
  /**
   * @param {import('./tracer')} parentTracer
   * @param {import('@opentelemetry/api').Context} context
   * @param {string | undefined} spanName
   * @param {import('./span_context')} spanContext
   * @param {import('@opentelemetry/api').SpanKind} kind
   * @param {Array<import('@opentelemetry/api').Link>} [links]
   * @param {import('@opentelemetry/api').TimeInput} [timeInput]
   * @param {import('@opentelemetry/api').Attributes} [attributes]
   */
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

    const ddSpan = new DatadogSpan(_tracer, _tracer._processor, _tracer._prioritySampler, {
      operationName: spanNameMapper(spanName, kind, attributes),
      context: spanContext._ddContext,
      startTime,
      hostname: _tracer._hostname,
      integrationName: parentTracer?._isOtelLibrary ? 'otel.library' : 'otel',
      tags: {
        [SERVICE_NAME]: _tracer._service,
        [RESOURCE_NAME]: spanName,
        [SPAN_KIND]: spanKindNames[kind],
      },
      links,
    }, _tracer._debug)

    super(ddSpan)

    if (attributes) {
      this.setAttributes(attributes)
    }

    this._parentTracer = parentTracer
    this._context = context

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

  /**
   * @param {string} ptrKind
   * @param {string} ptrDir
   * @param {string} ptrHash
   */
  addSpanPointer (ptrKind, ptrDir, ptrHash) {
    if (this.ended) return this
    const zeroContext = new SpanContext({
      traceId: id('0'),
      spanId: id('0'),
    })
    const attributes = {
      'ptr.kind': ptrKind,
      'ptr.dir': ptrDir,
      'ptr.hash': ptrHash,
      'link.kind': 'span-pointer',
    }
    return this.addLink(zeroContext, attributes)
  }

  /**
   * @param {string} name
   */
  updateName (name) {
    setOtelOperationName(this._ddSpan, name)
    return this
  }

  /**
   * @param {import('@opentelemetry/api').TimeInput} [timeInput]
   */
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

  get duration () {
    return this._ddSpan._duration
  }
}

module.exports = Span

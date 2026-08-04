'use strict'

const api = require('@opentelemetry/api')

function carrierFromTraceContext (traceContext) {
  if (!traceContext) return null

  const carrier = {}
  if (traceContext.traceParent) carrier.traceparent = traceContext.traceParent
  if (traceContext.traceState) carrier.tracestate = traceContext.traceState

  return Object.keys(carrier).length > 0 ? carrier : null
}

function extractContext (traceContext) {
  const carrier = carrierFromTraceContext(traceContext)
  if (!carrier) return api.context.active()

  return api.propagation.extract(api.context.active(), carrier, api.defaultTextMapGetter)
}

function runWithTraceContext (traceContext, fn) {
  return api.context.with(extractContext(traceContext), fn)
}

function getInvocationContext (args, trigger) {
  if (trigger === 'http') {
    return args[1]
  }
  if (trigger === 'durable-orchestration' || trigger === 'durable-entity') {
    return args[0]
  }
  if (trigger === 'durable-activity') {
    return args.at(-1)
  }
  if (trigger === 'orchestration-generic') {
    return args[1]
  }
}

function runWithInvocationContext (args, trigger, fn) {
  const invocationContext = getInvocationContext(args, trigger)
  return runWithTraceContext(invocationContext?.traceContext, fn)
}

module.exports = {
  carrierFromTraceContext,
  extractContext,
  getInvocationContext,
  runWithInvocationContext,
  runWithTraceContext,
}

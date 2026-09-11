'use strict'

const api = require('@opentelemetry/api')

const { writeTraceparent, writeTracestate } = require('../../../dd-trace/src/carrier')

const ROOT_CONTEXT = api.ROOT_CONTEXT

function carrierFromTraceContext (traceContext) {
  if (!traceContext) return null

  const carrier = {}
  if (traceContext.traceParent) writeTraceparent(carrier, traceContext.traceParent)
  if (traceContext.traceState) writeTracestate(carrier, traceContext.traceState)

  return Object.keys(carrier).length > 0 ? carrier : null
}

function extractContext (traceContext) {
  const carrier = carrierFromTraceContext(traceContext)
  if (!carrier) return ROOT_CONTEXT

  return api.propagation.extract(ROOT_CONTEXT, carrier, api.defaultTextMapGetter)
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
    const last = args.at(-1)
    if (last?.traceContext !== undefined || last?.invocationId !== undefined) {
      return last
    }
    return args.find(arg => arg?.traceContext !== undefined)
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

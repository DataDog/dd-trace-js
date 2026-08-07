'use strict'

const api = require('@opentelemetry/api')

const ROOT_CONTEXT = api.ROOT_CONTEXT

function carrierFromTraceContext (traceContext) {
  if (!traceContext) return null

  const carrier = {}
  if (traceContext.traceParent) carrier.traceparent = traceContext.traceParent
  if (traceContext.traceState) carrier.tracestate = traceContext.traceState

  return Object.keys(carrier).length > 0 ? carrier : null
}

function extractContext (traceContext) {
  const carrier = carrierFromTraceContext(traceContext)
  if (!carrier) return ROOT_CONTEXT

  return api.propagation.extract(ROOT_CONTEXT, carrier, api.defaultTextMapGetter)
}

function getInstanceId (invocationContext) {
  const attributes = invocationContext?.traceContext?.attributes
  if (!attributes) return undefined

  return attributes['durabletask.task.instance_id'] || attributes.DurableFunctionsInstanceId
}

function parentContextFromOrchestrationMeta (meta) {
  const { traceContextFromMeta } = require('./otel-orchestration-meta')
  return extractContext(traceContextFromMeta(meta))
}

function resolveActivityParentContext (invocationContext) {
  const instanceId = getInstanceId(invocationContext)
  const traceContext = invocationContext?.traceContext

  const { getOrchestrationSpan } = require('./otel-orchestration-registry')
  const orchestrationSpan = getOrchestrationSpan(instanceId)
  if (orchestrationSpan) {
    return api.trace.setSpan(extractContext(traceContext), orchestrationSpan)
  }

  const { readOrchestrationSpanMetaSync } = require('./otel-orchestration-store')
  const meta = readOrchestrationSpanMetaSync(instanceId, traceContext)
  if (meta) {
    return parentContextFromOrchestrationMeta(meta)
  }

  return extractContext(traceContext)
}

async function resolveActivityParentContextAsync (invocationContext) {
  const instanceId = getInstanceId(invocationContext)
  const traceContext = invocationContext?.traceContext

  const { getOrchestrationSpan } = require('./otel-orchestration-registry')
  const orchestrationSpan = getOrchestrationSpan(instanceId)
  if (orchestrationSpan) {
    return api.trace.setSpan(extractContext(traceContext), orchestrationSpan)
  }

  const {
    readOrchestrationSpanMetaAsync,
    readOrchestrationSpanMetaSync,
  } = require('./otel-orchestration-store')

  let meta = readOrchestrationSpanMetaSync(instanceId, traceContext)
  if (!meta) {
    meta = await readOrchestrationSpanMetaAsync(instanceId, traceContext)
  }
  if (meta) {
    return parentContextFromOrchestrationMeta(meta)
  }

  return extractContext(traceContext)
}

function buildSpanParentContext (args, trigger) {
  const invocationContext = getInvocationContext(args, trigger)
  if (trigger === 'durable-activity') {
    return resolveActivityParentContext(invocationContext)
  }

  return extractContext(invocationContext?.traceContext)
}

async function buildSpanParentContextAsync (args, trigger) {
  const invocationContext = getInvocationContext(args, trigger)
  if (trigger === 'durable-activity') {
    return resolveActivityParentContextAsync(invocationContext)
  }

  return extractContext(invocationContext?.traceContext)
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
  buildSpanParentContext,
  buildSpanParentContextAsync,
  carrierFromTraceContext,
  extractContext,
  getInstanceId,
  getInvocationContext,
  parentContextFromOrchestrationMeta,
  resolveActivityParentContext,
  runWithInvocationContext,
  runWithTraceContext,
}

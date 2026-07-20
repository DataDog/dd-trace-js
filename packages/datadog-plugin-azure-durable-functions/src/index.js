'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { AUTO_KEEP } = require('../../../ext/priority')
const TraceState = require('../../dd-trace/src/opentracing/propagation/tracestate')

class AzureDurableFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:datadog:azure:durable-functions:invoke' }
  static get type () { return 'serverless' }
  static get kind () { return 'server' }

  bindStart (ctx) {
    // Continue the trace propagated by the Durable Functions host (W3C traceparent
    // supplied on the invocation's traceContext) so activity/entity invocations join
    // the same trace as the HTTP root instead of each starting a new root.
    let childOf
    if (ctx.traceparent) {
      // extract() returns null when the carrier can't be parsed. Normalize to
      // undefined so startSpan still falls back to any active in-process parent
      // rather than being forced to start a brand new root span.
      childOf = this.tracer.extract('text_map', {
        traceparent: ctx.traceparent,
        tracestate: ctx.tracestate,
      }) ?? undefined
    }

    const span = this.startSpan(this.operationName(), {
      childOf,
      kind: 'internal',
      type: 'serverless',

      meta: {
        component: 'azure-functions',
        'aas.function.name': ctx.functionName,
        'aas.function.trigger': ctx.trigger,
        'resource.name': `${ctx.trigger} ${ctx.functionName}`,
      },
    }, ctx)

    // in the case of entity functions, operationName should be available
    if (ctx.operationName) {
      span.setTag('aas.function.operation', ctx.operationName)
      span.setTag('resource.name', `${ctx.trigger} ${ctx.functionName} ${ctx.operationName}`
      )
    }

    // The host clears the W3C sampled flag in traceparent while datadog tracestate
    // still says keep, so extraction would drop this chunk. Re-apply the propagated
    // `s` priority when it indicates keep; upstream drop decisions are left untouched.
    const propagatedPriority = propagatedSamplingPriority(ctx.tracestate)
    if (childOf && sampledFlagCleared(ctx.traceparent) && propagatedPriority >= AUTO_KEEP) {
      span._prioritySampler?.setPriority(span, propagatedPriority)
    }

    ctx.span = span
    return ctx.currentStore
  }

  end (ctx) {
    // We only want to run finish here if this is a synchronous operation
    // Only synchronous operations would have `result` or `error` on `end`
    // So we skip operations that dont
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return
    super.finish(ctx)
  }

  asyncStart (ctx) {
    super.finish(ctx)
  }
}

// True when the W3C traceparent's sampled flag is cleared (flags & 0x01 === 0),
// i.e. the carrier says "drop". Format: version-traceId-spanId-flags.
function sampledFlagCleared (traceparent) {
  if (typeof traceparent !== 'string') return false
  const flags = traceparent.split('-')[3]
  return flags !== undefined && (Number.parseInt(flags, 16) & 1) === 0
}

// Read the datadog-propagated sampling priority (`dd=...;s:<n>`) from a W3C
// tracestate. Returns undefined when there is no datadog tracestate or no valid
// `s` value, so callers can distinguish "no propagated decision" from a drop.
function propagatedSamplingPriority (tracestate) {
  if (typeof tracestate !== 'string' || !tracestate) return
  let priority
  TraceState.fromString(tracestate).forVendor('dd', state => {
    const parsed = Number.parseInt(state.get('s'), 10)
    if (Number.isInteger(parsed)) priority = parsed
  })
  return priority
}

module.exports = AzureDurableFunctionsPlugin

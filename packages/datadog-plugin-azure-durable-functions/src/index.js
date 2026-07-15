'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { USER_KEEP } = require('../../../ext/priority')

class AzureDurableFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:datadog:azure:durable-functions:invoke' }
  static get type () { return 'serverless' }
  static get kind () { return 'server' }

  bindStart (ctx) {
    // Continue the trace propagated by the Durable Functions host (W3C traceparent
    // supplied on the invocation's traceContext) so orchestrator/activity/entity
    // invocations join the same trace instead of each starting a new root.
    let childOf
    if (ctx.traceparent) {
      childOf = this.tracer.extract('text_map', {
        traceparent: ctx.traceparent,
        tracestate: ctx.tracestate,
      })
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

    // The Durable Functions host re-propagates the trace with the W3C sampled flag
    // cleared (traceparent `-00`) even when its tracestate still says keep (`s:1`),
    // so the continued activity/entity chunk inherits sampling priority 0 and would be
    // dropped independently of the kept HTTP root — leaving it out of the trace in
    // Datadog. A `manual.keep` tag is ignored here because the priority is already
    // locked by propagation, so override it directly to USER_KEEP to ensure every
    // chunk of the durable trace is retained.
    if (childOf) {
      span._prioritySampler.setPriority(span, USER_KEEP)
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

module.exports = AzureDurableFunctionsPlugin

'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { writeTraceparent, writeTracestate } = require('../../dd-trace/src/carrier')
const formats = require('../../../ext/formats')

class AzureDurableFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:datadog:azure:durable-functions:invoke' }
  static get type () { return 'serverless' }
  static get kind () { return 'server' }

  bindStart (ctx) {
    // Continue the trace propagated by the Durable Functions host so activity/entity
    // invocations join the HTTP root instead of each starting a new root.
    let childOf
    if (ctx.traceparent) {
      // extract() returns null when the carrier can't be parsed. Normalize to
      // undefined so startSpan still falls back to any active in-process parent.
      const carrier = {}
      writeTraceparent(carrier, ctx.traceparent)
      if (ctx.tracestate) writeTracestate(carrier, ctx.tracestate)
      childOf = this.tracer.extract('text_map', carrier) ?? undefined
    }

    // The host clears traceparent's sampled flag while tracestate still says keep.
    if (
      childOf &&
      this.tracer._config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT === 'continue'
    ) {
      this.tracer._propagators?.[formats.TEXT_MAP]
        ?.applyTracestateKeepOverClearedFlag(childOf, ctx.tracestate)
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

    if (ctx.operationName) {
      span.setTag('aas.function.operation', ctx.operationName)
      span.setTag('resource.name', `${ctx.trigger} ${ctx.functionName} ${ctx.operationName}`
      )
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

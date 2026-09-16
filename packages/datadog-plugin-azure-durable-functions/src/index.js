'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { AUTO_KEEP } = require('../../../ext/priority')
const { writeTraceparent, writeTracestate } = require('../../dd-trace/src/carrier')

const ORCHESTRATION_FAILURE_END_CHANNEL =
  'tracing:orchestrion:durable-functions:TaskOrchestrationExecutor_failure:end'
const ORCHESTRATOR_COMPLETED_EVENT_TYPE = 13

class AzureDurableFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:datadog:azure:durable-functions:invoke' }
  static get type () { return 'serverless' }
  static get kind () { return 'server' }

  addTraceSubs () {
    super.addTraceSubs()
    this.addSub(ORCHESTRATION_FAILURE_END_CHANNEL, this.orchestrationFailure)
  }

  bindStart (ctx) {
    // Continue the trace propagated by the Durable Functions host (W3C traceparent
    // supplied on the invocation's traceContext) so activity/entity invocations join
    // the same trace as the HTTP root instead of each starting a new root.
    let childOf
    if (ctx.traceparent) {
      // extract() returns null when the carrier can't be parsed. Normalize to
      // undefined so startSpan still falls back to any active in-process parent
      // rather than being forced to start a brand new root span.
      const carrier = {}

      writeTraceparent(carrier, ctx.traceparent)
      if (ctx.tracestate) {
        writeTracestate(carrier, ctx.tracestate)
      }

      childOf = this.tracer.extract('text_map', carrier) ?? undefined
    }
    const extractedAsDrop = childOf?._sampling.priority < AUTO_KEEP

    const span = this.startSpan(this.operationName(), {
      startTime: ctx.startTime,
      childOf,
      kind: ctx.trigger === 'Orchestration' ? 'server' : 'internal',
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
    // still says keep, so extraction would drop this chunk. Re-apply only the propagated
    // `s` priority when it indicates keep, preserving the extracted sampling mechanism.
    if (span._prioritySampler && childOf && extractedAsDrop) {
      const propagatedPriority = propagatedSamplingPriority(childOf._tracestate)
      if (propagatedPriority >= AUTO_KEEP) {
        const spanContext = span.context()
        if (spanContext._parentId === childOf._spanId) {
          spanContext._sampling.priority = propagatedPriority
        }
      }
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

  /**
   * Tags the active initial orchestration span or creates a failure-only span after
   * a resumed orchestration throws. The executor publishes synchronously before
   * Durable Functions serializes the error, so this does not add a promise to
   * orchestration activations.
   *
   * @param {{ arguments?: unknown[], error?: unknown }} executorCtx
   */
  orchestrationFailure (executorCtx) {
    const args = executorCtx?.arguments
    if (!Array.isArray(args)) return

    const invocationContext = args[0]
    const history = args[1]
    if (!Array.isArray(history)) return

    const hasPreviousActivation = history.some(
      event => event?.EventType === ORCHESTRATOR_COMPLETED_EVENT_TYPE
    )

    if (!hasPreviousActivation) {
      this.addError(executorCtx.error)
      return
    }

    const traceContext = invocationContext?.traceContext
    const ctx = {
      trigger: 'Orchestration',
      functionName: invocationContext?.functionName,
      traceparent: traceContext?.traceParent,
      tracestate: traceContext?.traceState,
      error: executorCtx.error,
    }

    this.bindStart(ctx)
    this.error(ctx)
    super.finish(ctx)
  }
}

// Read the datadog-propagated sampling priority (`dd=...;s:<n>`) from a W3C
// tracestate. Returns undefined when there is no datadog tracestate or no valid
// `s` value, so callers can distinguish "no propagated decision" from a drop.
function propagatedSamplingPriority (tracestate) {
  return tracestate?.forVendor('dd', state => {
    const priority = Number(state.get('s'))
    return Number.isInteger(priority) ? priority : undefined
  })
}

module.exports = AzureDurableFunctionsPlugin

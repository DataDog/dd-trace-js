'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

/**
 * APM spans for the phases of one OpenAI Realtime turn.
 *
 * The turn is replayed as a back-dated tree once it is complete, so every span here is created with
 * an explicit `startTime` and finished with an explicit `finishTime` rather than measuring wall
 * clock. Nesting falls out of the synchronous scoping of the instrumentation's `traceSync` calls:
 * the phase spans are created inside the turn root's callback, so `startSpan` picks the root up as
 * their parent from the active store.
 */
class RealtimeTracingPlugin extends TracingPlugin {
  // `component` defaults to the plugin id, which differs per phase here, so pin both explicitly to
  // keep `component:openai` consistent with every other span the integration emits.
  static component = 'openai'
  static system = 'openai'

  /**
   * Whether a failed response marks this span errored. True for the model's own work and for the
   * turn as a whole; false for the speaking windows, which describe when audio moved rather than
   * whether the model succeeded.
   */
  static flagsFailure = true

  /**
   * The APM resource name for this phase. Implemented by every subclass.
   *
   * @param {object} ctx
   * @throws {Error} When a subclass has not implemented it.
   */
  resource (ctx) {
    throw new Error(`resource must be implemented by ${this.constructor.name}`)
  }

  /**
   * @param {object} ctx
   * @returns {object}
   */
  bindStart (ctx) {
    this.startSpan('openai.request', {
      service: this.config.service,
      resource: this.resource(ctx),
      type: 'openai',
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        'openai.request.model': ctx.turn.model,
      },
      startTime: ctx.startTime,
    }, ctx)

    return ctx.currentStore
  }

  /**
   * @param {object} ctx
   * @returns {void}
   */
  end (ctx) {
    const span = ctx.currentStore?.span
    if (span === undefined) return

    if (ctx.turn.failed && this.constructor.flagsFailure) span.setTag('error', 1)
    span.finish(ctx.finishTime)
  }
}

/** The whole perceived turn, and the root of this turn's trace. */
class RealtimeTurnTracingPlugin extends RealtimeTracingPlugin {
  static id = 'openai_realtime_turn'
  static operation = 'turn'
  static prefix = 'tracing:apm:openai:realtime:turn'

  constructor (...args) {
    super(...args)

    // Captured at `response.created`, replayed at finalize: by then the active context belongs to
    // the WebSocket message handler, not to the caller who opened the connection. The LLM
    // Observability plugin composes its own store on top of whatever this sets.
    this.addSub('dd-trace:openai:realtime:capture-context', turn => {
      const store = storage('legacy').getStore()
      const previous = turn.runInContext
      turn.runInContext = previous === undefined
        ? fn => storage('legacy').run(store, fn)
        : fn => previous(() => storage('legacy').run(store, fn))
    })
  }

  resource () {
    return 'createRealtimeTurn'
  }
}

/** The model's generation work: opens at the end of user speech, closes at `response.done`. */
class RealtimeResponseTracingPlugin extends RealtimeTracingPlugin {
  static id = 'openai_realtime_response'
  static operation = 'response'
  static prefix = 'tracing:apm:openai:realtime:response'

  resource () {
    return 'createRealtimeResponse'
  }
}

/**
 * A speaking window — the human's or the agent's. One plugin covers both: they differ only by
 * resource and name, which is data, not a type.
 */
class RealtimeSpeechTracingPlugin extends RealtimeTracingPlugin {
  static id = 'openai_realtime_speech'
  static operation = 'speech'
  static prefix = 'tracing:apm:openai:realtime:speech'
  // A speaking window happened regardless of whether the model's response failed.
  static flagsFailure = false

  /**
   * @param {{ phase: { operation: string } }} ctx
   * @returns {string}
   */
  resource (ctx) {
    return ctx.phase.operation
  }
}

module.exports = [
  RealtimeTurnTracingPlugin,
  RealtimeResponseTracingPlugin,
  RealtimeSpeechTracingPlugin,
]

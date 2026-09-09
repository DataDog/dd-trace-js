'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const normalizeError = require('./error')

class SupabaseRealtimeChannelSendPlugin extends ProducerPlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/realtime-js:RealtimeChannel_send'
  static peerServicePrecursors = ['messaging.destination.name']

  /**
   * Starts a producer span for a Supabase Realtime broadcast.
   *
   * @param {object} ctx Orchestrion context for RealtimeChannel.send().
   * @returns {object|undefined} Span store.
   */
  bindStart (ctx) {
    const destination = ctx.self?.subTopic

    this.startSpan({
      service: { name: this.tracer._service },
      type: 'messaging',
      resource: destination,
      meta: {
        component: 'supabase',
        'span.kind': 'producer',
        'messaging.system': 'supabase',
        'messaging.destination.name': destination,
        'messaging.destination.kind': 'topic',
        'messaging.operation': 'send',
      },
    }, ctx)

    return ctx.currentStore
  }

  /** @returns {string} Supabase Realtime producer operation name. */
  operationName () {
    return 'supabase.messaging.send'
  }

  /**
   * Finishes an asynchronous Supabase Realtime broadcast.
   *
   * @param {object} ctx Completed Orchestrion context.
   * @returns {void}
   */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  /**
   * Records the Realtime send result and finishes its producer span.
   *
   * @param {object} ctx Completed Orchestrion context.
   * @returns {void}
   */
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const result = ctx.result
    if (result === 'error' || result === 'timed out') {
      ctx.error = normalizeError(result, 'RealtimeSendError', `Realtime send returned ${result}`)
      super.error(ctx)
    }

    super.finish(ctx)
  }
}

module.exports = SupabaseRealtimeChannelSendPlugin

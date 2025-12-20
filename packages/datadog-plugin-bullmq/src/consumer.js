'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class BullmqConsumerPlugin extends ConsumerPlugin {
  static id = 'bullmq'
  static prefix = 'tracing:orchestrion:bullmq:Worker_processJob'
  static bullmqOperation = 'processJob'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan({
      meta
    }, ctx)

    return ctx.currentStore
  }

  operationName (opts = {}) {
    return super.operationName({ ...opts, id: 'bullmq', operation: this.constructor.bullmqOperation })
  }

  serviceName (opts = {}) {
    return super.serviceName({ ...opts, id: 'bullmq' })
  }

  getTags (ctx) {
    return {
      component: 'bullmq',
      'span.kind': 'consumer'
    }
  }

  // asyncEnd and end delegate to finish() which has the required guard
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = BullmqConsumerPlugin

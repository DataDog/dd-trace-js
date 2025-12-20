'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class BaseBullmqProducerPlugin extends ProducerPlugin {
  static id = 'bullmq'
  static prefix = 'tracing:orchestrion:bullmq:Queue_add'
  static bullmqOperation = 'add'

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
      'span.kind': 'producer'
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

class QueueAddBulkPlugin extends BaseBullmqProducerPlugin {
  static id = 'bullmq-queue-addBulk'
  static prefix = 'tracing:orchestrion:bullmq:Queue_addBulk'
  static bullmqOperation = 'addBulk'
}

class FlowProducerAddPlugin extends BaseBullmqProducerPlugin {
  static id = 'bullmq-flowproducer-add'
  static prefix = 'tracing:orchestrion:bullmq:FlowProducer_add'
  static bullmqOperation = 'add'
}

module.exports = [
  BaseBullmqProducerPlugin,
  QueueAddBulkPlugin,
  FlowProducerAddPlugin
]

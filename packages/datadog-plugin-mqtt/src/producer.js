'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class BaseMqttProducerPlugin extends ProducerPlugin {
  static id = 'mqtt'
  static prefix = 'tracing:orchestrion:mqtt:publish'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan({
      meta,
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'mqtt',
      'span.kind': 'producer',
      'messaging.system': 'mqtt',
      'messaging.destination.name': ctx.arguments?.[0],
      'messaging.operation': 'send',
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

class PublishAsyncPlugin extends BaseMqttProducerPlugin {
  static prefix = 'tracing:orchestrion:mqtt:publishAsync'

  getTags (ctx) {
    return {
      component: 'mqtt',
      'span.kind': 'producer',
      'messaging.system': 'mqtt',
      'messaging.destination.name': ctx.arguments?.[0],
      'messaging.operation': 'publish',
    }
  }
}

module.exports = {
  BaseMqttProducerPlugin,
  PublishAsyncPlugin,
}

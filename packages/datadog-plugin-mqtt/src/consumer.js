'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class BaseMqttConsumerPlugin extends ConsumerPlugin {
  static id = 'mqtt'
  static prefix = 'tracing:orchestrion:mqtt:handlePublish'

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
      'span.kind': 'consumer',
      'messaging.system': 'mqtt',
      'messaging.destination.name': ctx.arguments?.[1]?.topic,
      'messaging.operation': 'receive',
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

class HandlePubrelPlugin extends BaseMqttConsumerPlugin {
  static prefix = 'tracing:orchestrion:mqtt:handlePubrel'
}

module.exports = {
  BaseMqttConsumerPlugin,
  HandlePubrelPlugin,
}

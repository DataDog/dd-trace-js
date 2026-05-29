'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')

class BaseNitroServerPlugin extends ServerPlugin {
  static id = 'nitro'
  static prefix = 'tracing:orchestrion:nitro:tracingPlugin'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan({
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'nitro',
      'span.kind': 'server'
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

class TracingPluginPlugin extends BaseNitroServerPlugin {
  static prefix = 'tracing:orchestrion:nitro:tracingPlugin'
}

module.exports = {
  'BaseNitroServerPlugin': BaseNitroServerPlugin,
  'TracingPluginPlugin': TracingPluginPlugin
}

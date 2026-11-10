'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class AsyncMutexPlugin extends TracingPlugin {
  static id = 'async-mutex'
  static prefix = 'tracing:apm:async-mutex:acquire'

  bindStart (ctx) {
    const { weight, priority, contended } = ctx

    const metrics = {}
    if (weight !== 1) metrics['async_mutex.weight'] = weight
    if (priority !== 0) metrics['async_mutex.priority'] = priority
    if (contended !== undefined) metrics['async_mutex.contended'] = contended ? 1 : 0

    this.startSpan('async-mutex.acquire', {
      service: this.config.service || this._tracerConfig.service,
      resource: 'acquire',
      meta: {
        component: 'async-mutex',
      },
      metrics,
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)

    return ctx.parentStore
  }
}

module.exports = AsyncMutexPlugin

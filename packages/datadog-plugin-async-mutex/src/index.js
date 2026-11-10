'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class AsyncMutexPlugin extends TracingPlugin {
  static id = 'async-mutex'
  static prefix = 'tracing:orchestrion:async-mutex:Semaphore_acquire'

  bindStart (ctx) {
    const weight = ctx.arguments?.[0] ?? 1
    const priority = ctx.arguments?.[1] ?? 0
    const semaphore = ctx.self

    const metrics = {}
    if (weight !== 1) metrics['async_mutex.weight'] = weight
    if (priority !== 0) metrics['async_mutex.priority'] = priority
    // `_couldLockImmediately` is the library's own predicate for "would this queue". Guarded so a
    // version that drops it reports nothing rather than a wrong answer.
    if (typeof semaphore?._couldLockImmediately === 'function') {
      metrics['async_mutex.contended'] = semaphore._couldLockImmediately(weight, priority) ? 0 : 1
    }

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

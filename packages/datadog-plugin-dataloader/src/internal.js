'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const activeLoadMany = new WeakMap()
const legacyStorage = storage('legacy')

class DataloaderLoadPlugin extends TracingPlugin {
  static id = 'dataloader'
  static operation = 'load'
  static prefix = 'tracing:orchestrion:dataloader:DataLoader_load'

  /**
   * @param {{ currentStore?: object, self?: { name?: string }, suppressed?: boolean }} ctx
   * @returns {object | undefined}
   */
  bindStart (ctx) {
    if (this.operation === 'load' && ctx.self && activeLoadMany.has(ctx.self)) {
      ctx.suppressed = true
      return legacyStorage.getStore()
    }

    const spanName = this.operation === 'load' ? 'dataloader.load' : 'dataloader.loadMany'
    this.startSpan(spanName, {
      service: this.config.service,
      resource: ctx.self?.name,
      kind: 'internal',
    }, ctx)

    return ctx.currentStore
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object, suppressed?: boolean }} ctx
   * @returns {void}
   */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object, suppressed?: boolean }} ctx
   * @returns {void}
   */
  end (ctx) {
    this.finish(ctx)
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object, suppressed?: boolean }} ctx
   * @returns {void}
   */
  finish (ctx) {
    if (ctx.suppressed) return

    // The operation can emit an early end event before its promise settles.
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }

  /**
   * @param {{ error?: unknown, currentStore?: object, suppressed?: boolean }} ctx
   * @returns {void}
   */
  error (ctx) {
    if (ctx.suppressed) return

    super.error(ctx)
  }
}

class DataloaderLoadManyPlugin extends DataloaderLoadPlugin {
  static operation = 'loadMany'
  static prefix = 'tracing:orchestrion:dataloader:DataLoader_loadMany'

  bindStart (ctx) {
    if (ctx.self) activeLoadMany.set(ctx.self, (activeLoadMany.get(ctx.self) || 0) + 1)

    return super.bindStart(ctx)
  }

  end (ctx) {
    try {
      super.end(ctx)
    } finally {
      const count = ctx.self && activeLoadMany.get(ctx.self)
      if (count === 1) {
        activeLoadMany.delete(ctx.self)
      } else if (count) {
        activeLoadMany.set(ctx.self, count - 1)
      }
    }
  }
}

module.exports = {
  load: DataloaderLoadPlugin,
  loadMany: DataloaderLoadManyPlugin,
}

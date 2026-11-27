'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class DataloaderLoadPlugin extends TracingPlugin {
  static id = 'dataloader'
  static operation = 'load'
  static prefix = 'tracing:orchestrion:dataloader:DataLoader_load'

  /**
   * @param {{ currentStore?: object, self?: { name?: string } }} ctx
   * @returns {object | undefined}
   */
  bindStart (ctx) {
    const spanName = this.operation === 'load' ? 'dataloader.load' : 'dataloader.loadMany'
    this.startSpan(spanName, {
      service: this.config.service,
      resource: ctx.self?.name,
      kind: 'internal',
    }, ctx)

    return ctx.currentStore
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object }} ctx
   */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object }} ctx
   */
  end (ctx) {
    this.finish(ctx)
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object }} ctx
   */
  finish (ctx) {
    // The operation can emit an early end event before its promise settles.
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class DataloaderLoadManyPlugin extends DataloaderLoadPlugin {
  static operation = 'loadMany'
  static prefix = 'tracing:orchestrion:dataloader:DataLoader_loadMany'
}

module.exports = {
  load: DataloaderLoadPlugin,
  loadMany: DataloaderLoadManyPlugin,
}

'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class DataloaderLoadPlugin extends TracingPlugin {
  static id = 'dataloader'
  static operation = 'load'
  static prefix = 'tracing:orchestrion:dataloader:DataLoader_load'
  static spanName = 'dataloader.load'

  /**
   * @param {{ currentStore?: object, self?: { name?: string } }} ctx
   * @returns {object | undefined}
   */
  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      resource: ctx.self?.name,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /**
   * @param {{ self?: { name?: string } }} ctx
   * @returns {{ component: string, 'span.kind': string }}
   */
  getTags (ctx) {
    return {
      component: 'dataloader',
      'span.kind': 'internal',
    }
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object }} ctx
   * @returns {void}
   */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object }} ctx
   * @returns {void}
   */
  end (ctx) {
    this.finish(ctx)
  }

  /**
   * @param {{ result?: unknown, error?: unknown, currentStore?: object }} ctx
   * @returns {void}
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
  static spanName = 'dataloader.loadMany'
}

module.exports = {
  load: DataloaderLoadPlugin,
  loadMany: DataloaderLoadManyPlugin,
}

'use strict'

const { storage } = require('../../../../datadog-core')
const TracingPlugin = require('../../../../dd-trace/src/plugins/tracing')

const legacyStorage = storage('legacy')

class SonicTracingPlugin extends TracingPlugin {
  static id = 'bedrockruntime_sonic'
  static component = 'aws-sdk'
  static operation = 'sonic'
  static prefix = 'tracing:apm:aws:bedrockruntime:sonic:span'

  constructor (...args) {
    super(...args)
    this.addSub('dd-trace:aws:bedrockruntime:sonic:capture-context', context => {
      const store = legacyStorage.getStore()
      const previous = context.runInContext ?? (fn => fn())
      context.runInContext = fn => previous(() => legacyStorage.run(store, fn))
    })
  }

  /** @param {object} ctx */
  bindStart (ctx) {
    this.startSpan('aws.bedrockruntime.sonic', {
      service: this.config.service,
      resource: ctx.name,
      type: 'bedrockruntime',
      kind: 'client',
      startTime: ctx.startTime,
      meta: { 'aws.bedrock.request.model': ctx.model },
    }, ctx)
    return ctx.currentStore
  }

  /** @param {object} ctx */
  end (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    if (ctx.descriptor.error) span.setTag('error', ctx.descriptor.error)
    span.finish(ctx.finishTime)
  }
}

module.exports = SonicTracingPlugin

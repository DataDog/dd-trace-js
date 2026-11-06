'use strict'

const { channel } = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const ElevenLabsLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/elevenlabs')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const annotate = channel('apm:elevenlabs:annotate')

/** @typedef {import('../../datadog-instrumentations/src/elevenlabs/session').Scope} Scope */
/** @typedef {import('../../datadog-core/src/storage').Store<unknown>} Store */

class ElevenLabsTracingPlugin extends TracingPlugin {
  static id = 'elevenlabs'
  static prefix = 'tracing:apm:elevenlabs:span'

  constructor (...args) {
    super(...args)
    this.addSub('dd-trace:elevenlabs:capture-context', message => {
      const scope = /** @type {Scope} */ (message)
      // An absent store intentionally restores an explicit root context.
      const store = /** @type {Store} */ (storage('legacy').getStore())
      const previous = scope.runInContext ?? (fn => fn())
      scope.runInContext = fn => previous(() => storage('legacy').run(store, fn))
    })
    this.addSub('apm:elevenlabs:finish', ctx => this.finish(ctx))
  }

  /** @param {object} ctx */
  bindStart (ctx) {
    this.startSpan('elevenlabs.request', {
      service: this.config.service,
      resource: ctx.name,
      type: 'llm',
      kind: 'client',
      startTime: ctx.startTime,
    }, ctx)
    return ctx.currentStore
  }

  /** @param {object} ctx */
  end (ctx) { if (!ctx.deferred && !ctx.promise) this.finish(ctx) }

  /** @param {object} ctx */
  asyncEnd (ctx) { this.finish(ctx) }

  /** @param {object} ctx */
  finish (ctx) {
    if (ctx.finished) return
    const span = ctx.currentStore?.span
    // Configuration changes can reorder subscribers. Keep deferred spans, speech phases, and
    // asynchronous tools annotated before serialization through one explicit completion owner.
    annotate.publish(ctx)
    if (ctx.error) this.addError(ctx.error, span)
    if (ctx.turn.failed && ['elevenlabs audio turn', 'elevenlabs response'].includes(ctx.name)) {
      span?.setTag('error', 1)
    }
    span?.finish(ctx.finishTime)
    ctx.finished = true
  }
}

class ElevenLabsPlugin extends CompositePlugin {
  static id = 'elevenlabs'
  static get plugins () {
    return { llmobs: ElevenLabsLLMObsPlugin, tracing: ElevenLabsTracingPlugin }
  }
}

module.exports = ElevenLabsPlugin

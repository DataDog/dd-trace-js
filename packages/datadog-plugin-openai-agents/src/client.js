'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { spanHasError } = require('../../dd-trace/src/llmobs/util')

class BaseOpenaiAgentsClientPlugin extends TracingPlugin {
  static id = 'openai-agents'

  bindStart (ctx) {
    this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      meta: {
        component: 'openai-agents',
        'span.kind': 'client',
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    // Both end and asyncEnd fire for async orchestrion spans; skip the early
    // end event (no result/error yet) so the span finishes only on asyncEnd.
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class GetStreamedResponsePlugin extends BaseOpenaiAgentsClientPlugin {
  static id = 'openai-agents-get-streamed-response'
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getStreamedResponse'
  static spanName = 'openai-agents.getStreamedResponse'

  // For AsyncIterator kind, traceSync sets ctx.result = Promise before `end` fires,
  // so the base class guard (`hasOwnProperty('result')`) would incorrectly finish the span.
  // Override `end` to be a no-op — the span stays open until the iterator is exhausted.
  end () {}

  asyncEnd (ctx) {
    // Span stays open until the iterator is exhausted.
    // Only finish early if getStreamedResponse itself rejected before returning the iterator.
    if (ctx.error) {
      super.finish(ctx)
    }
  }
}

class GetStreamedResponseNextPlugin extends TracingPlugin {
  static id = 'openai-agents-get-streamed-response-next'
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getStreamedResponse_next'

  bindStart (ctx) {
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    if (ctx.result?.done === true || spanHasError(span)) {
      span.finish()
    }
  }
}

class GetResponsePlugin extends BaseOpenaiAgentsClientPlugin {
  static id = 'openai-agents-get-response'
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getResponse'
  static spanName = 'openai-agents.getResponse'
}

module.exports = [GetStreamedResponsePlugin, GetStreamedResponseNextPlugin, GetResponsePlugin]

'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class BaseGenkitClientPlugin extends ClientPlugin {
  static id = 'genkit'
  static prefix = 'tracing:orchestrion:@genkit-ai/ai:GenkitAI_generate'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('genkit.generate', {
      service: this.serviceName({ pluginService: this.config.service }),
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'genkit',
      'span.kind': 'client'
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

class GenkitAiGenerateStreamPlugin extends BaseGenkitClientPlugin {
  static prefix = 'tracing:orchestrion:@genkit-ai/ai:GenkitAI_generateStream'
}

class ChatSendPlugin extends BaseGenkitClientPlugin {
  static prefix = 'tracing:orchestrion:@genkit-ai/ai:Chat_send'
}

module.exports = {
  'BaseGenkitClientPlugin': BaseGenkitClientPlugin,
  'GenkitAiGenerateStreamPlugin': GenkitAiGenerateStreamPlugin,
  'ChatSendPlugin': ChatSendPlugin
}

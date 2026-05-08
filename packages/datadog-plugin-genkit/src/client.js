'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

/**
 * Extracts the model name from a Genkit generate/chat call's arguments.
 *
 * The model argument can be:
 * - A string (e.g. 'echo/model', 'googleai/gemini-pro')
 * - A model reference (function) returned by ai.defineModel(), whose __action.name holds the model key
 *
 * @param {object} ctx - The orchestrion context object
 * @returns {string | undefined} The model name, or undefined if not available
 */
function getModelName (ctx) {
  const args = ctx.arguments
  if (!args?.[0]) return

  const model = args[0].model ?? args[0]
  if (typeof model === 'string') return model
  if (typeof model === 'function') return model.__action?.name ?? model.name
}

class BaseGenkitClientPlugin extends ClientPlugin {
  static id = 'genkit'
  static prefix = 'tracing:orchestrion:@genkit-ai/ai:GenkitAI_generate'
  static peerServicePrecursors = ['genkit.ai.model']
  static spanName = 'genkit.generate'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      kind: this.constructor.kind,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    const tags = {}

    const modelName = getModelName(ctx)
    if (modelName) {
      tags['genkit.ai.model'] = modelName
    }

    return tags
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
  static spanName = 'genkit.generateStream'
}

class ChatSendPlugin extends BaseGenkitClientPlugin {
  static prefix = 'tracing:orchestrion:@genkit-ai/ai:Chat_send'
  static spanName = 'genkit.send'
}

module.exports = {
  BaseGenkitClientPlugin,
  GenkitAiGenerateStreamPlugin,
  ChatSendPlugin,
}

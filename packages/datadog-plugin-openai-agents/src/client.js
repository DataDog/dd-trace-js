'use strict'

const { URL } = require('node:url')

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const log = require('../../dd-trace/src/log')

class BaseOpenaiAgentsClientPlugin extends ClientPlugin {
  static id = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getResponse'
  static spanName = 'openai-agents.getResponse'
  static peerServicePrecursors = ['out.host']

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /**
   * Extracts the hostname from the OpenAI client's baseURL.
   *
   * @param {string} baseURL - The base URL string from the OpenAI client
   * @returns {string|undefined} The hostname or undefined if parsing fails
   */
  getHostFromBaseURL (baseURL) {
    try {
      return new URL(baseURL).hostname
    } catch (e) {
      log.error('openai-agents: failed to parse baseURL %s', baseURL, e)
    }
  }

  getTags (ctx) {
    const tags = {
      component: 'openai-agents',
      'span.kind': 'client',
      'ai.request.model_provider': 'openai',
    }

    const modelName = ctx.self?._model
    if (modelName) {
      tags['ai.request.model'] = modelName
      tags['openai.request.model'] = modelName
      tags['resource.name'] = modelName
    }

    const baseURL = ctx.self?._client?.baseURL
    if (baseURL) {
      const host = this.getHostFromBaseURL(baseURL)
      if (host) {
        tags['out.host'] = host
      }
    }

    return tags
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

    this.addResponseTags(ctx)
    super.finish(ctx)
  }

  /**
   * @param {{ currentStore?: { span: object }, result?: object }} ctx - The orchestrion context
   */
  addResponseTags (ctx) {
    const span = ctx.currentStore?.span
    const result = ctx.result
    if (!span || !result) return

    if (result.responseId) {
      span.setTag('openai.response.id', result.responseId)
    }

    const usage = result.usage
    if (usage) {
      if (usage.inputTokens !== undefined) {
        span.setTag('openai.response.usage.prompt_tokens', usage.inputTokens)
      }
      if (usage.outputTokens !== undefined) {
        span.setTag('openai.response.usage.completion_tokens', usage.outputTokens)
      }
      if (usage.totalTokens !== undefined) {
        span.setTag('openai.response.usage.total_tokens', usage.totalTokens)
      }
    }
  }
}

class GetStreamedResponsePlugin extends BaseOpenaiAgentsClientPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getStreamedResponse'
  static spanName = 'openai-agents.getStreamedResponse'

  getTags (ctx) {
    const tags = super.getTags(ctx)
    tags['openai.request.stream'] = 'true'
    return tags
  }
}

class GetResponsePlugin extends BaseOpenaiAgentsClientPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getResponse'
  static spanName = 'openai-agents.getResponse'
}

module.exports = {
  GetStreamedResponsePlugin,
  GetResponsePlugin,
}

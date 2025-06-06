'use strict'

const LangChainLanguageModelHandler = require('.')

const COMPLETIONS = 'langchain.response.completions'

class LangChainChatModelHandler extends LangChainLanguageModelHandler {
  getSpanStartTags (ctx, provider, span) {
    const tags = {}

    const inputs = ctx.args?.[0]

    for (let messageSetIndex = 0; messageSetIndex < inputs.length; messageSetIndex++) {
      const messageSet = inputs[messageSetIndex]

      for (let messageIndex = 0; messageIndex < messageSet.length; messageIndex++) {
        const message = messageSet[messageIndex]
        if (this.isPromptCompletionSampled(span)) {
          tags[`langchain.request.messages.${messageSetIndex}.${messageIndex}.content`] =
            this.normalize(message.content) || ''
        }
        tags[`langchain.request.messages.${messageSetIndex}.${messageIndex}.message_type`] = message.constructor.name
      }
    }

    const instance = ctx.instance
    const identifyingParams = (typeof instance._identifyingParams === 'function' && instance._identifyingParams()) || {}
    for (const [param, val] of Object.entries(identifyingParams)) {
      if (param.toLowerCase().includes('apikey') || param.toLowerCase().includes('apitoken')) continue
      if (typeof val === 'object') {
        for (const [key, value] of Object.entries(val)) {
          tags[`langchain.request.${provider}.parameters.${param}.${key}`] = value
        }
      } else {
        tags[`langchain.request.${provider}.parameters.${param}`] = val
      }
    }

    return tags
  }

  getSpanEndTags ({ result, currentStore }, span) {
    if (!result?.generations) {
      return {}
    }

    const tags = {}

    const sampled = this.isPromptCompletionSampled(span)

    this.extractTokenMetrics(currentStore?.span, result)

    for (let messageSetIdx = 0; messageSetIdx < result.generations.length; messageSetIdx++) {
      const messageSet = result.generations[messageSetIdx]

      for (let chatCompletionIdx = 0; chatCompletionIdx < messageSet.length; chatCompletionIdx++) {
        const { text, message } = messageSet[chatCompletionIdx]
        const prefix = `${COMPLETIONS}.${messageSetIdx}.${chatCompletionIdx}`

        if (text && sampled) {
          tags[`${prefix}.content`] = this.normalize(text)
        }

        tags[`${prefix}.message_type`] = message.constructor.name

        let toolCalls = message.tool_calls
        if (toolCalls) {
          if (!Array.isArray(toolCalls)) {
            toolCalls = [toolCalls]
          }

          for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex++) {
            const { id, name, args } = toolCalls[toolCallIndex]
            const toolCallsPrefix = `${prefix}.tool_calls.${toolCallIndex}`

            tags[`${toolCallsPrefix}.id`] = id
            tags[`${toolCallsPrefix}.name`] = name

            if (args) {
              for (const [name, value] of Object.entries(args)) {
                tags[`${toolCallsPrefix}.args.${name}`] = this.normalize(value)
              }
            }
          }
        }
      }
    }

    return tags
  }
}

module.exports = LangChainChatModelHandler

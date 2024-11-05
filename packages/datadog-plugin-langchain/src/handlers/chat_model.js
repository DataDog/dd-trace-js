'use strict'

const { truncate } = require('../util')

const COMPLETIONS = 'langchain.response.completions'

function getStartTags (ctx, provider) {
  const tags = {}

  const inputs = ctx.args?.[0]

  for (const messageSetIndex in inputs) {
    const messageSet = inputs[messageSetIndex]

    for (const messageIndex in messageSet) {
      const message = messageSet[messageIndex]
      tags[`langchain.request.messages.${messageSetIndex}.${messageIndex}.content`] = message.content || ''
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

function getEndTags (ctx) {
  const { result } = ctx

  const tags = {}

  // TODO: do we need token tagging

  for (const messageSetIdx in result.generations) {
    const messageSet = result.generations[messageSetIdx]

    for (const chatCompletionIdx in messageSet) {
      const chatCompletion = messageSet[chatCompletionIdx]

      const text = chatCompletion.text
      const message = chatCompletion.message
      let toolCalls = message.tool_calls

      if (text) {
        tags[
          `${COMPLETIONS}.${messageSetIdx}.${chatCompletionIdx}.content`
        ] = truncate(text)
      }

      tags[
        `${COMPLETIONS}.${messageSetIdx}.${chatCompletionIdx}.message_type`
      ] = message.constructor.name

      if (toolCalls) {
        if (!Array.isArray(toolCalls)) {
          toolCalls = [toolCalls]
        }

        for (const toolCallIndex in toolCalls) {
          const toolCall = toolCalls[toolCallIndex]

          tags[
            `${COMPLETIONS}.${messageSetIdx}.${chatCompletionIdx}.tool_calls.${toolCallIndex}.id`
          ] = toolCall.id
          tags[
            `${COMPLETIONS}.${messageSetIdx}.${chatCompletionIdx}.tool_calls.${toolCallIndex}.name`
          ] = toolCall.name

          const args = toolCall.args || {}
          for (const [name, value] of Object.entries(args)) {
            tags[
              `${COMPLETIONS}.${messageSetIdx}.${chatCompletionIdx}.tool_calls.${toolCallIndex}.args.${name}`
            ] = truncate(value)
          }
        }
      }
    }
  }

  return tags
}

module.exports = {
  getStartTags,
  getEndTags
}

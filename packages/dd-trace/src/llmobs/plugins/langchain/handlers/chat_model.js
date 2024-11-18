'use strict'

const LangChainLLMObsHandler = require('.')
const LLMObsTagger = require('../../../tagger')
const { spanHasError } = require('../../../util')

const LLM = 'llm'

class LangChainLLMObsChatModelHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results, options, integrationName }) {
    if (integrationName === 'openai' && options?.response_format) {
      // langchain-openai will call a beta client if "response_format" is passed in on the options object
      // we do not trace these calls, so this should be an llm span
      this._tagger.changeKind(span, LLM)
    }
    const spanKind = LLMObsTagger.getSpanKind(span)
    const isWorkflow = spanKind === 'workflow'

    const inputMessages = []
    if (!Array.isArray(inputs)) inputs = [inputs]

    for (const messageSet of inputs) {
      for (const message of messageSet) {
        const content = message.content || ''
        const role = this.getRole(message)
        inputMessages.push({ content, role })
      }
    }

    if (spanHasError(span)) {
      if (isWorkflow) {
        this._tagger.tagTextIO(span, inputMessages, [{ content: '' }])
      } else {
        this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      }
      return
    }

    const outputMessages = []
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0
    let tokensSetTopLevel = false
    const tokensPerRunId = {}

    if (!isWorkflow) {
      const tokens = this.checkTokenUsageChatOrLLMResult(results)
      inputTokens = tokens.inputTokens
      outputTokens = tokens.outputTokens
      totalTokens = tokens.totalTokens
      tokensSetTopLevel = totalTokens > 0
    }

    for (const messageSet of results.generations) {
      for (const chatCompletion of messageSet) {
        const chatCompletionMessage = chatCompletion.message
        const role = this.getRole(chatCompletionMessage)
        const content = chatCompletionMessage.text || ''
        const toolCalls = this.extractToolCalls(chatCompletionMessage)
        outputMessages.push({ content, role, toolCalls })

        if (!isWorkflow && !tokensSetTopLevel) {
          const { tokens, runId } = this.checkTokenUsageFromAIMessage(chatCompletionMessage)
          if (!tokensPerRunId[runId]) {
            tokensPerRunId[runId] = tokens
          } else {
            tokensPerRunId[runId].inputTokens += tokens.inputTokens
            tokensPerRunId[runId].outputTokens += tokens.outputTokens
            tokensPerRunId[runId].totalTokens += tokens.totalTokens
          }
        }
      }
    }

    if (!isWorkflow && !tokensSetTopLevel) {
      inputTokens = Object.values(tokensPerRunId).reduce((acc, val) => acc + val.inputTokens, 0)
      outputTokens = Object.values(tokensPerRunId).reduce((acc, val) => acc + val.outputTokens, 0)
      totalTokens = Object.values(tokensPerRunId).reduce((acc, val) => acc + val.totalTokens, 0)
    }

    if (isWorkflow) {
      this._tagger.tagTextIO(span, inputMessages, outputMessages)
    } else {
      this._tagger.tagLLMIO(span, inputMessages, outputMessages)
      this._tagger.tagMetrics(span, {
        inputTokens,
        outputTokens,
        totalTokens
      })
    }
  }

  extractToolCalls (message) {
    let toolCalls = message.tool_calls
    if (!toolCalls) return []

    const toolCallsInfo = []
    if (!Array.isArray(toolCalls)) toolCalls = [toolCalls]
    for (const toolCall of toolCalls) {
      toolCallsInfo.push({
        name: toolCall.name || '',
        arguments: toolCall.args || {},
        tool_id: toolCall.id || ''
      })
    }

    return toolCallsInfo
  }
}

module.exports = LangChainLLMObsChatModelHandler

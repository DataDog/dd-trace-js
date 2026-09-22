'use strict'

const LLMObsTagger = require('../../../tagger')
const { spanHasError } = require('../../../util')
const { getRole } = require('../messages')
const LangChainLLMObsHandler = require('.')

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
        const role = getRole(message)
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

    for (const messageSet of results.generations) {
      for (const chatCompletion of messageSet) {
        const chatCompletionMessage = chatCompletion.message
        const role = getRole(chatCompletionMessage)
        const content = chatCompletionMessage.text || ''
        const toolCalls = this.extractToolCalls(chatCompletionMessage)
        outputMessages.push({ content, role, toolCalls })
      }
    }

    if (isWorkflow) {
      this._tagger.tagTextIO(span, inputMessages, outputMessages)
    } else {
      this._tagger.tagLLMIO(span, inputMessages, outputMessages)
      this._tagger.tagMetrics(span, this.getTokenUsage(results))
    }
  }

  /**
   * @override
   */
  getTokenUsage (results) {
    const tokens = this.checkTokenUsageChatOrLLMResult(results)
    if (tokens.totalTokens > 0) return tokens

    // providers that report usage on each generated message instead of on `llmOutput`; counts are
    // summed per run so a run split across generations is totalled once
    if (!results.generations) return tokens

    const tokensPerRunId = {}
    for (const messageSet of results.generations) {
      for (const chatCompletion of messageSet) {
        const { tokens: messageTokens, runId } = this.checkTokenUsageFromAIMessage(chatCompletion.message)
        if (tokensPerRunId[runId]) {
          tokensPerRunId[runId].inputTokens += messageTokens.inputTokens
          tokensPerRunId[runId].outputTokens += messageTokens.outputTokens
          tokensPerRunId[runId].totalTokens += messageTokens.totalTokens
        } else {
          tokensPerRunId[runId] = messageTokens
        }
      }
    }

    const perRun = Object.values(tokensPerRunId)
    return {
      inputTokens: perRun.reduce((acc, val) => acc + val.inputTokens, 0),
      outputTokens: perRun.reduce((acc, val) => acc + val.outputTokens, 0),
      totalTokens: perRun.reduce((acc, val) => acc + val.totalTokens, 0),
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
        tool_id: toolCall.id || '',
      })
    }

    return toolCallsInfo
  }
}

module.exports = LangChainLLMObsChatModelHandler

'use strict'

const ROLE_MAPPINGS = {
  human: 'user',
  ai: 'assistant',
  system: 'system'
}

class LangChainLLMObsHandler {
  constructor (tagger) {
    this._tagger = tagger
  }

  setMetaTags () {}

  formatIO (messages) {
    if (messages.constructor.name === 'Object') { // plain JSON
      const formatted = {}
      for (const [key, value] of Object.entries(messages)) {
        formatted[key] = this.formatIO(value)
      }

      return formatted
    } else if (Array.isArray(messages)) {
      return messages.map(message => this.formatIO(message))
    } else { // either a BaseMesage type or a string
      return this.getContentFromMessage(messages)
    }
  }

  getContentFromMessage (message) {
    if (typeof message === 'string') {
      return message
    } else {
      try {
        const messageContent = {}
        messageContent.content = message.content || ''

        const role = this.getRole(message)
        if (role) messageContent.role = role

        return messageContent
      } catch {
        return JSON.stringify(message)
      }
    }
  }

  checkTokenUsageChatOrLLMResult (results) {
    const llmOutput = results.llmOutput
    const tokens = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
    if (!llmOutput) return tokens
    const tokenUsage = llmOutput.tokenUsage || llmOutput.usageMetadata || llmOutput.usage || {}
    if (!tokenUsage) return tokens

    tokens.inputTokens = tokenUsage.promptTokens || tokenUsage.inputTokens || 0
    tokens.outputTokens = tokenUsage.completionTokens || tokenUsage.outputTokens || 0
    tokens.totalTokens = tokenUsage.totalTokens || tokens.inputTokens + tokens.outputTokens

    return tokens
  }

  checkTokenUsageFromAIMessage (message) {
    let usage = message.usage_metadata || message.additional_kwargs?.usage
    const runId = message.run_id || message.id || ''
    const runIdBase = runId ? runId.split('-').slice(0, -1).join('-') : ''

    const responseMetadata = message.response_metadata || {}
    usage = usage || responseMetadata.usage || responseMetadata.tokenUsage || {}

    const inputTokens = usage.promptTokens || usage.inputTokens || usage.prompt_tokens || usage.input_tokens || 0
    const outputTokens =
      usage.completionTokens || usage.outputTokens || usage.completion_tokens || usage.output_tokens || 0
    const totalTokens = usage.totalTokens || inputTokens + outputTokens

    return {
      tokens: {
        inputTokens,
        outputTokens,
        totalTokens
      },
      runId: runIdBase
    }
  }

  getRole (message) {
    if (message.role) return ROLE_MAPPINGS[message.role] || message.role

    const type = (
      (typeof message.getType === 'function' && message.getType()) ||
      (typeof message._getType === 'function' && message._getType())
    )

    return ROLE_MAPPINGS[type] || type
  }
}

module.exports = LangChainLLMObsHandler

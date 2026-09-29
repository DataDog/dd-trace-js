'use strict'

class LangChainLLMObsHandler {
  constructor (tagger) {
    /** @type {import('../../../tagger')} */
    this._tagger = tagger
  }

  /**
   * @param {{
   *   span?: import('../../../../opentracing/span'),
   *   instance?: Record<string, unknown>,
   *   options?: { metadata?: { langgraph_node?: string } }
   * }} params
   * @returns {string | undefined}
   */
  getName ({ span }) {
    const name = span?.context()?.getTag('resource.name')
    return typeof name === 'string' ? name : undefined
  }

  setMetaTags () {}

  checkTokenUsageChatOrLLMResult (results) {
    const llmOutput = results.llmOutput
    const tokens = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
    if (!llmOutput) return tokens
    const tokenUsage = llmOutput.tokenUsage || llmOutput.token_usage || llmOutput.usageMetadata ||
      llmOutput.usage_metadata || llmOutput.usage
    if (!tokenUsage) return tokens

    tokens.inputTokens = tokenUsage.promptTokens || tokenUsage.inputTokens ||
      tokenUsage.prompt_tokens || tokenUsage.input_tokens || 0
    tokens.outputTokens = tokenUsage.completionTokens || tokenUsage.outputTokens ||
      tokenUsage.completion_tokens || tokenUsage.output_tokens || 0
    tokens.totalTokens = tokenUsage.totalTokens || tokenUsage.total_tokens ||
      tokens.inputTokens + tokens.outputTokens

    return tokens
  }

  checkTokenUsageFromAIMessage (message) {
    let usage = message.usage_metadata || message.additional_kwargs?.usage
    const runId = message.run_id || message.id || ''
    const runIdBase = runId ? runId.split('-').slice(0, -1).join('-') : ''

    const responseMetadata = message.response_metadata || {}
    usage ||= responseMetadata.usage || responseMetadata.tokenUsage || {}

    const inputTokens = usage.promptTokens || usage.inputTokens || usage.prompt_tokens || usage.input_tokens || 0
    const outputTokens =
      usage.completionTokens || usage.outputTokens || usage.completion_tokens || usage.output_tokens || 0
    const totalTokens = usage.totalTokens || usage.total_tokens || inputTokens + outputTokens

    return {
      tokens: {
        inputTokens,
        outputTokens,
        totalTokens,
      },
      runId: runIdBase,
    }
  }
}

module.exports = LangChainLLMObsHandler

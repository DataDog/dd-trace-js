'use strict'

const LangChainLanguageModelHandler = require('.')

class LangChainLLMHandler extends LangChainLanguageModelHandler {
  getSpanStartTags (ctx, provider, span) {
    const tags = {}

    const prompts = ctx.args?.[0]
    for (const promptIdx in prompts) {
      if (!this.isPromptCompletionSampled(span)) continue

      const prompt = prompts[promptIdx]
      tags[`langchain.request.prompts.${promptIdx}.content`] = this.normalize(prompt) || ''
    }

    const instance = ctx.instance
    const identifyingParams = (typeof instance._identifyingParams === 'function' && instance._identifyingParams()) || {}
    for (const [param, val] of Object.entries(identifyingParams)) {
      if (param.toLowerCase().includes('apikey') || param.toLowerCase().includes('apitoken')) continue
      if (val !== null && typeof val === 'object') {
        for (const [key, value] of Object.entries(val)) {
          tags[`langchain.request.${provider}.parameters.${param}.${key}`] = value
        }
      } else {
        tags[`langchain.request.${provider}.parameters.${param}`] = val
      }
    }

    return tags
  }

  getSpanEndTags (ctx, span) {
    const { result } = ctx

    const tags = {}
    const sampled = this.isPromptCompletionSampled(span)

    this.extractTokenMetrics(ctx.currentStore?.span, result)

    for (const completionIdx in result?.generations) {
      const completion = result.generations[completionIdx]
      if (sampled) {
        tags[`langchain.response.completions.${completionIdx}.text`] = this.normalize(completion[0].text) || ''
      }

      if (completion && completion[0].generationInfo) {
        const generationInfo = completion[0].generationInfo
        tags[`langchain.response.completions.${completionIdx}.finish_reason`] = generationInfo.finishReason
        tags[`langchain.response.completions.${completionIdx}.logprobs`] = generationInfo.logprobs
      }
    }

    return tags
  }
}

module.exports = LangChainLLMHandler

'use strict'

const LangChainLanguageModelHandler = require('.')

class LangChainLLMHandler extends LangChainLanguageModelHandler {
  getSpanStartTags (ctx, provider, span) {
    const tags = {}

    const prompts = ctx.args?.[0]
    for (let promptIdx = 0; promptIdx < prompts.length; promptIdx++) {
      if (!this.isPromptCompletionSampled(span)) continue

      const prompt = prompts[promptIdx]
      tags[`langchain.request.prompts.${promptIdx}.content`] = this.normalize(prompt) || ''
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

    for (let completionIdx = 0; completionIdx < result.generations.length; completionIdx++) {
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

'use strict'

const { truncate } = require('../util')

function getStartTags (ctx, provider) {
  const tags = {}

  const prompts = ctx.args?.[0]
  for (const promptIdx in prompts) {
    const prompt = prompts[promptIdx]
    tags[`langchain.request.prompts.${promptIdx}.content`] = truncate(prompt) || ''
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
}

function getEndTags (ctx) {
  const { result } = ctx

  const tags = {}

  for (const completionIdx in result.generations) {
    const completion = result.completions[completionIdx]
    tags[`langchain.response.completions.${completionIdx}.text`] = completion[0].text || ''

    if (completion && completion[0].generationInfo) {
      const generationInfo = completion[0].generationInfo
      tags[`langchain.response.completions.${completionIdx}.finish_reason`] = generationInfo.finishReason
      tags[`langchain.response.completions.${completionIdx}.logprobs`] = generationInfo.logprobs
    }
  }

  return tags
}

module.exports = {
  getStartTags,
  getEndTags
}

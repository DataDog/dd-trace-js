'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const makeUtilities = require('../../dd-trace/src/plugins/util/llm')

class GoogleCloudVertexAIPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-vertexai' }
  static get prefix () {
    return 'tracing:apm:vertexai:request'
  }

  constructor () {
    super(...arguments)

    this.utilities = makeUtilities('vertexai', this._tracerConfig)
  }

  bindStart (ctx) {
    const { instance, request, resource, stream } = ctx

    const tags = this.tagRequest(request, instance, stream)

    const span = this.startSpan('vertexai.request', {
      service: this.config.service,
      resource,
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        ...tags
      }
    }, false)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { result } = ctx

    const response = result?.response
    if (response) {
      const tags = this.tagResponse(response)
      span.addTags(tags)
    }

    span.finish()
  }

  tagRequest (request, instance, stream) {
    // request is either a string or an object with a `contents` property
    const model = extractModel(instance)
    const tags = {
      'vertexai.request.model': model
    }

    const history = instance.historyInternal
    let contents = typeof request === 'string' ? request : request.contents
    if (history) {
      if (Array.isArray(contents)) {
        contents = [history, ...contents]
      } else if (typeof request === 'object') {
        contents = [history, contents]
      }
    }

    const generationConfig = instance.generationConfig || {}
    for (const key of Object.keys(generationConfig)) {
      const transformedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
      tags[`vertexai.request.generation_config.${transformedKey}`] = JSON.stringify(generationConfig[key])
    }

    if (stream) {
      tags['vertexai.request.stream'] = true
    }

    if (!this.utilities.isPromptCompletionSampled()) return tags

    const systemInstructions = extractSystemInstructions(instance)

    for (const idx in systemInstructions) {
      tags[`vertexai.request.system_instruction.${idx}.text`] = systemInstructions[idx]
    }

    if (typeof contents === 'string') {
      tags['vertexai.request.contents.0.text'] = contents

      return tags
    }

    for (const contentIdx in contents) {
      const content = contents[contentIdx]

      const role = content?.role
      const parts = content?.parts

      tags[`vertexai.request.contents.${contentIdx}.role`] = role
      for (const partIdx in parts) {
        const part = parts[partIdx]
        tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.text`] = part.text

        const functionCall = part.functionCall
        const functionResponse = part.functionResponse

        if (functionCall) {
          tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.function_call.name`] = functionCall.name
          tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.function_call.args`] =
              JSON.stringify(functionCall.args)
        }
        if (functionResponse) {
          tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.function_response.name`] =
              functionResponse.name
          tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.function_response.response`] =
              JSON.stringify(functionResponse.response)
        }
      }
    }

    return tags
  }

  tagResponse (response) {
    const tags = {}

    const candidates = response.candidates
    for (const candidateIdx in candidates) {
      const candidate = candidates[candidateIdx]
      const finishReason = candidate.finishReason
      if (finishReason) {
        tags[`vertexai.response.candidates.${candidateIdx}.finish_reason`] = finishReason
      }
      const candidateContent = candidate.content
      const role = candidateContent.role
      tags[`vertexai.response.candidates.${candidateIdx}.content.role`] = role

      if (!this.utilities.isPromptCompletionSampled()) continue

      const parts = candidateContent.parts
      for (const partIdx in parts) {
        const part = parts[partIdx]

        const text = part.text
        tags[`vertexai.response.candidates.${candidateIdx}.content.parts.${partIdx}.text`] = String(text)

        const functionCall = part.functionCall
        if (!functionCall) continue

        tags[`vertexai.response.candidates.${candidateIdx}.content.parts.${partIdx}.function_call.name`] =
          functionCall.name
        tags[`vertexai.response.candidates.${candidateIdx}.content.parts.${partIdx}.function_call.args`] =
          JSON.stringify(functionCall.args)
      }
    }

    const tokenCounts = response.usageMetadata
    if (tokenCounts) {
      tags['vertexai.response.usage.prompt_tokens'] = tokenCounts.promptTokenCount
      tags['vertexai.response.usage.completion_tokens'] = tokenCounts.candidatesTokenCount
      tags['vertexai.response.usage.total_tokens'] = tokenCounts.totalTokenCount
    }

    return tags
  }
}

function extractModel (instance) {
  const model = instance.model || instance.resourcePath
  return model?.split('/').pop()
}

function extractSystemInstructions (instance) {
  // systemInstruction is either a string or a Content object
  // Content objects have parts (Part[]) and a role
  const systemInstruction = instance.systemInstruction
  if (!systemInstruction) return []
  if (typeof systemInstruction === 'string') return [systemInstruction]

  return systemInstruction.parts?.map(part => part.text)
}

module.exports = GoogleCloudVertexAIPlugin

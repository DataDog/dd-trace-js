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

    Object.assign(this, makeUtilities('vertexai', this._tracerConfig))
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
    const model = extractModel(instance)
    const tags = {
      'vertexai.request.model': model
    }

    const history = instance.historyInternal
    let contents = typeof request === 'string' || Array.isArray(request) ? request : request.contents
    if (history) {
      contents = [...history, ...(Array.isArray(contents) ? contents : [contents])]
    }

    const generationConfig = instance.generationConfig || {}
    for (const key of Object.keys(generationConfig)) {
      const transformedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
      tags[`vertexai.request.generation_config.${transformedKey}`] = JSON.stringify(generationConfig[key])
    }

    if (stream) {
      tags['vertexai.request.stream'] = true
    }

    if (!this.isPromptCompletionSampled()) return tags

    const systemInstructions = extractSystemInstructions(instance)

    for (const [idx, systemInstruction] of systemInstructions.entries()) {
      tags[`vertexai.request.system_instruction.${idx}.text`] = systemInstruction
    }

    if (typeof contents === 'string') {
      tags['vertexai.request.contents.0.text'] = contents
      return tags
    }

    for (const [contentIdx, content] of contents.entries()) {
      this.tagRequestContent(tags, content, contentIdx)
    }

    return tags
  }

  tagRequestPart (part, tags, partIdx, contentIdx) {
    tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.text`] = this.normalize(part.text)

    const functionCall = part.functionCall
    const functionResponse = part.functionResponse

    if (functionCall) {
      tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.function_call.name`] = functionCall.name
      tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.function_call.args`] =
              this.normalize(JSON.stringify(functionCall.args))
    }
    if (functionResponse) {
      tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.function_response.name`] =
              functionResponse.name
      tags[`vertexai.request.contents.${contentIdx}.parts.${partIdx}.function_response.response`] =
              this.normalize(JSON.stringify(functionResponse.response))
    }
  }

  tagRequestContent (tags, content, contentIdx) {
    if (typeof content === 'string') {
      tags[`vertexai.request.contents.${contentIdx}.text`] = this.normalize(content)
      return
    }

    if (content.text || content.functionCall || content.functionResponse) {
      this.tagRequestPart(content, tags, 0, contentIdx)
      return
    }

    const { role, parts } = content
    if (role) {
      tags[`vertexai.request.contents.${contentIdx}.role`] = role
    }

    for (const [partIdx, part] of parts.entries()) {
      this.tagRequestPart(part, tags, partIdx, contentIdx)
    }
  }

  tagResponse (response) {
    const tags = {}

    const candidates = response.candidates
    for (const [candidateIdx, candidate] of candidates.entries()) {
      const finishReason = candidate.finishReason
      if (finishReason) {
        tags[`vertexai.response.candidates.${candidateIdx}.finish_reason`] = finishReason
      }
      const candidateContent = candidate.content
      const role = candidateContent.role
      tags[`vertexai.response.candidates.${candidateIdx}.content.role`] = role

      if (!this.isPromptCompletionSampled()) continue

      const parts = candidateContent.parts
      for (const [partIdx, part] of parts.entries()) {
        const text = part.text
        tags[`vertexai.response.candidates.${candidateIdx}.content.parts.${partIdx}.text`] =
          this.normalize(String(text))

        const functionCall = part.functionCall
        if (!functionCall) continue

        tags[`vertexai.response.candidates.${candidateIdx}.content.parts.${partIdx}.function_call.name`] =
          functionCall.name
        tags[`vertexai.response.candidates.${candidateIdx}.content.parts.${partIdx}.function_call.args`] =
          this.normalize(JSON.stringify(functionCall.args))
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
  const model = instance.model || instance.resourcePath || instance.publisherModelEndpoint
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

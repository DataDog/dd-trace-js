'use strict'

const LLMObsPlugin = require('./base')
const {
  extractModel,
  extractSystemInstructions
} = require('../../../../datadog-plugin-google-cloud-vertexai/src/utils')

class VertexAILLMObsPlugin extends LLMObsPlugin {
  static get id () { return 'vertexai' } // used for llmobs telemetry
  static get prefix () {
    return 'tracing:apm:vertexai:request'
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const history = ctx.instance?.historyInternal || []
    ctx.history = history

    return {
      kind: 'llm',
      modelName: extractModel(ctx.instance),
      modelProvider: 'google',
      name: ctx.resource
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { instance, result, request } = ctx
    const history = ctx.history || []
    const systemInstructions = extractSystemInstructions(instance)

    const metadata = this._getMetadata(instance)
    const inputMessages = this._extractInputMessages(request, history, systemInstructions)
    const outputMessages = this._extractOutputMessages(result)
    const metrics = this._extractMetrics(result)

    this._tagger.tagLLMIO(span, inputMessages, outputMessages)
    this._tagger.tagMetadata(span, metadata)
    this._tagger.tagMetrics(span, metrics)
  }

  _getMetadata (instance) {
    const metadata = {}

    const modelConfig = instance.generationConfig
    if (!modelConfig) return metadata

    for (const [parameter, parameterKey] of [
      ['temperature', 'temperature'],
      ['maxOutputTokens', 'max_output_tokens'],
      ['candidateCount', 'candidate_count'],
      ['topP', 'top_p'],
      ['topK', 'top_k']
    ]) {
      if (modelConfig[parameter]) {
        metadata[parameterKey] = modelConfig[parameter]
      }
    }

    return metadata
  }

  _extractInputMessages (request, history, systemInstructions) {
    const contents = typeof request === 'string' || Array.isArray(request) ? request : request.contents
    const messages = []

    if (systemInstructions) {
      for (const instruction of systemInstructions) {
        messages.push({ content: instruction || '', role: 'system' })
      }
    }

    for (const content of history) {
      messages.push(...this._extractMessagesFromContent(content))
    }

    if (typeof contents === 'string') {
      messages.push({ content: contents })
      return messages
    }

    if (isPart(contents)) {
      messages.push(this._extractMessageFromPart(contents))
      return messages
    }

    if (!Array.isArray(contents)) {
      messages.push({
        content: '[Non-array content object: ' +
        `${(typeof contents.toString === 'function' ? contents.toString() : String(contents))}]`
      })
      return messages
    }

    for (const content of contents) {
      if (typeof content === 'string') {
        messages.push({ content })
        continue
      }

      if (isPart(content)) {
        messages.push(this._extractMessageFromPart(content))
        continue
      }

      messages.push(...this._extractMessagesFromContent(content))
    }

    return messages
  }

  _extractOutputMessages (result) {
    if (!result) return [{ content: '' }]
    const { response } = result

    if (!response) return [{ content: '' }]

    const outputMessages = []
    const candidates = response.candidates || []
    for (const candidate of candidates) {
      const content = candidate.content || ''
      outputMessages.push(...this._extractMessagesFromContent(content))
    }

    return outputMessages
  }

  _extractMessagesFromContent (content) {
    const messages = []

    const role = content.role || ''
    const parts = content.parts || []
    if (parts == null || parts.length === 0 || !Array.isArray(parts)) {
      const message = {
        content:
        `[Non-text content object: ${(typeof content.toString === 'function' ? content.toString() : String(content))}]`
      }
      if (role) message.role = role
      messages.push(message)
      return messages
    }

    for (const part of parts) {
      const message = this._extractMessageFromPart(part, role)
      messages.push(message)
    }

    return messages
  }

  _extractMessageFromPart (part, role) {
    const text = part.text || ''
    const functionCall = part.functionCall
    const functionResponse = part.functionResponse

    const message = { content: text }
    if (role) message.role = role
    if (functionCall) {
      message.toolCalls = [{
        name: functionCall.name,
        arguments: functionCall.args
      }]
    }
    if (functionResponse) {
      message.content = `[tool result: ${functionResponse.response}]`
    }

    return message
  }

  _extractMetrics (result) {
    if (!result) return {}
    const { response } = result

    if (!response) return {}

    const tokenCounts = response.usageMetadata
    const metrics = {}
    if (tokenCounts) {
      metrics.inputTokens = tokenCounts.promptTokenCount
      metrics.outputTokens = tokenCounts.candidatesTokenCount
      metrics.totalTokens = tokenCounts.totalTokenCount
    }

    return metrics
  }
}

function isPart (part) {
  return part.text || part.functionCall || part.functionResponse
}

module.exports = VertexAILLMObsPlugin

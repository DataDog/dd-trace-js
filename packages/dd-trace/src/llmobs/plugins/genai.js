'use strict'

const LLMObsPlugin = require('./base')

// Constants for role mapping
const ROLES = {
  MODEL: 'model',
  ASSISTANT: 'assistant',
  USER: 'user',
  REASONING: 'reasoning'
}

class GenAiLLMObsPlugin extends LLMObsPlugin {
  static id = 'genai'
  static integration = 'genai'
  static prefix = 'tracing:apm:google:genai:request'

  constructor () {
    super(...arguments)

    // Subscribe to streaming chunk events
    this.addSub('apm:google:genai:request:chunk', ({ ctx, chunk, done }) => {
      ctx.isStreaming = true
      ctx.chunks = ctx.chunks || []

      if (chunk) ctx.chunks.push(chunk)
      if (!done) return

      // Aggregate streaming chunks into a single response
      ctx.result = this.#aggregateStreamingChunks(ctx.chunks)
    })
  }

  // ============================================================================
  // Public API Methods
  // ============================================================================

  getLLMObsSpanRegisterOptions (ctx) {
    const { args, methodName } = ctx
    if (!methodName) return

    const inputs = args[0]
    const operation = getOperation(methodName)
    const kind = operation

    return {
      modelProvider: 'google',
      modelName: inputs.model,
      kind,
      name: 'google_genai.request'
    }
  }

  setLLMObsTags (ctx) {
    const { args, methodName } = ctx
    const span = ctx.currentStore?.span
    if (!methodName) return

    const inputs = args[0]
    const response = ctx.result
    const error = !!span.context()._tags.error

    const operation = getOperation(methodName)

    if (operation === 'llm') {
      this._tagGenerateContent(span, inputs, response, error, ctx.isStreaming)
    } else if (operation === 'embedding') {
      this._tagEmbedding(span, inputs, response, error)
    }

    if (!error && response) {
      const metrics = this._extractMetrics(response)
      this._tagger.tagMetrics(span, metrics)
    }
  }

  // ============================================================================
  // Streaming Utilities
  // ============================================================================

  #aggregateStreamingChunks (chunks) {
    const response = { candidates: [] }

    for (const chunk of chunks) {
      if (chunk.candidates) {
        // Flatten candidates array
        response.candidates.push(...chunk.candidates)
      }
      if (chunk.usageMetadata) {
        response.usageMetadata = chunk.usageMetadata
      }
    }

    return response
  }

  // ============================================================================
  // Tagging Methods
  // ============================================================================

  _tagGenerateContent (span, inputs, response, error, isStreaming = false) {
    const { config = {} } = inputs

    const inputMessages = this._formatInputMessages(inputs.contents)

    const metadata = this._extractMetadata(config)
    this._tagger.tagMetadata(span, metadata)

    if (error) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    const outputMessages = this._formatOutputMessages(response, isStreaming)
    this._tagger.tagLLMIO(span, inputMessages, outputMessages)

  }

  _tagEmbedding (span, inputs, response, error) {
    const embeddingInput = this._formatEmbeddingInput(inputs.contents)

    if (error) {
      this._tagger.tagEmbeddingIO(span, embeddingInput)
      return
    }

    const embeddingOutput = this._formatEmbeddingOutput(response)
    this._tagger.tagEmbeddingIO(span, embeddingInput, embeddingOutput)
  }

  // ============================================================================
  // Input Formatting
  // ============================================================================

  _formatInputMessages (contents) {
    if (!contents) return []

    const contentArray = Array.isArray(contents) ? contents : [contents]
    const messages = []

    for (const content of contentArray) {
      if (typeof content === 'string') {
        messages.push({ role: ROLES.USER, content })
      } else if (content.text) {
        messages.push({ role: ROLES.USER, content: content.text })
      } else if (content.parts) {
        const message = this._formatContentObject(content)
        if (message) messages.push(message)
      } else {
        messages.push({ role: ROLES.USER, content: JSON.stringify(content) })
      }
    }

    return messages
  }

  _formatContentObject (content) {
    const parts = content.parts || []
    const role = this._determineRole(content, parts)

    // Check if this is a thought/reasoning part
    if (this._hasThoughtParts(parts)) {
      return {
        role: ROLES.REASONING,
        content: this._extractTextParts(parts).join('\n')
      }
    }

    // Check for function calls
    const functionCalls = parts.filter(part => part.functionCall)
    if (functionCalls.length > 0) {
      return this._formatFunctionCallMessage(parts, functionCalls, role)
    }

    // Check for function responses
    const functionResponses = parts.filter(part => part.functionResponse)
    if (functionResponses.length > 0) {
      return this._formatFunctionResponseMessage(functionResponses, role)
    }

    // Regular text content
    return {
      role,
      content: this._extractTextParts(parts).join('\n')
    }
  }

  _formatEmbeddingInput (contents) {
    if (!contents) return []

    const contentArray = Array.isArray(contents) ? contents : [contents]
    const documents = []

    for (const content of contentArray) {
      if (typeof content === 'string') {
        documents.push({ text: content })
      } else if (content.text) {
        documents.push({ text: content.text })
      } else if (content.parts) {
        for (const part of content.parts) {
          if (typeof part === 'string') {
            documents.push({ text: part })
          } else if (part.text) {
            documents.push({ text: part.text })
          }
        }
      }
    }

    return documents
  }

  // ============================================================================
  // Output Formatting
  // ============================================================================

  _formatOutputMessages (response, isStreaming = false) {
    if (!response?.candidates?.length) {
      return [{ content: '' }]
    }

    if (isStreaming) {
      return this._formatStreamingOutput(response)
    }

    return this._formatNonStreamingOutput(response)
  }

  _formatStreamingOutput (response) {
    const messages = []
    const messagesByRole = new Map()

    for (const candidate of response.candidates) {
      const content = Array.isArray(candidate) ? candidate[0].content : candidate.content
      if (!content?.parts) continue

      // Skip special cases in streaming (handle them as non-streaming)
      if (content.parts.some(part => part.functionCall ||
                                     part.executableCode ||
                                     part.codeExecutionResult)) {
        messages.push(...this._formatNonStreamingCandidate(candidate))
        continue
      }

      // Accumulate text parts by role
      const partsByRole = this._groupPartsByRole(content.parts)

      for (const [partRole, textContent] of Object.entries(partsByRole)) {
        if (!textContent) continue

        if (messagesByRole.has(partRole)) {
          const index = messagesByRole.get(partRole)
          messages[index].content += textContent
        } else {
          const messageIndex = messages.length
          messages.push({ role: partRole, content: textContent })
          messagesByRole.set(partRole, messageIndex)
        }
      }
    }

    return messages.length > 0 ? messages : [{ content: '' }]
  }

  _formatNonStreamingOutput (response) {
    const messages = []

    for (const candidate of response.candidates) {
      messages.push(...this._formatNonStreamingCandidate(candidate))
    }

    return messages.length > 0 ? messages : [{ content: '' }]
  }

  _formatNonStreamingCandidate (candidate) {
    const messages = []
    const content = Array.isArray(candidate) ? candidate[0].content : candidate.content

    if (!content?.parts) return messages

    const { parts } = content

    // Check for function calls
    const functionCalls = parts.filter(part => part.functionCall)
    if (functionCalls.length > 0) {
      messages.push(this._formatFunctionCallMessage(parts, functionCalls, ROLES.ASSISTANT))
      return messages
    }

    // Check for executable code
    const executableCode = parts.find(part => part.executableCode)
    if (executableCode) {
      messages.push({
        role: ROLES.ASSISTANT,
        content: JSON.stringify({
          language: executableCode.executableCode.language,
          code: executableCode.executableCode.code
        })
      })
      return messages
    }

    // Check for code execution result
    const codeExecutionResult = parts.find(part => part.codeExecutionResult)
    if (codeExecutionResult) {
      messages.push({
        role: ROLES.ASSISTANT,
        content: JSON.stringify({
          outcome: codeExecutionResult.codeExecutionResult.outcome,
          output: codeExecutionResult.codeExecutionResult.output
        })
      })
      return messages
    }

    // Regular text content - may contain both reasoning and assistant parts
    const partsByRole = this._groupPartsByRole(parts)

    if (partsByRole.reasoning) {
      messages.push({
        role: ROLES.REASONING,
        content: partsByRole.reasoning
      })
    }

    if (partsByRole.assistant) {
      messages.push({
        role: ROLES.ASSISTANT,
        content: partsByRole.assistant
      })
    }

    return messages
  }

  _formatEmbeddingOutput (response) {
    if (!response?.embeddings?.length) {
      return ''
    }

    const embeddingCount = response.embeddings.length
    const firstEmbedding = response.embeddings[0]

    if (firstEmbedding.values && Array.isArray(firstEmbedding.values)) {
      const embeddingDim = firstEmbedding.values.length
      return `[${embeddingCount} embedding(s) returned with size ${embeddingDim}]`
    }

    return `[${embeddingCount} embedding(s) returned]`
  }

  // ============================================================================
  // Function Call/Response Formatting
  // ============================================================================

  _formatFunctionCallMessage (parts, functionCalls, role) {
    const toolCalls = functionCalls.map(part => ({
      name: part.functionCall.name,
      arguments: part.functionCall.args,
      toolId: part.functionCall.id || '',
      type: 'function_call'
    }))

    const textParts = this._extractTextParts(parts)
    const content = textParts.length > 0 ? textParts.join('\n') : undefined

    return {
      role,
      ...(content && { content }),
      toolCalls
    }
  }

  _formatFunctionResponseMessage (functionResponses, role) {
    const toolResults = functionResponses.map(part => ({
      name: part.functionResponse.name,
      result: JSON.stringify(part.functionResponse.response),
      toolId: part.functionResponse.id,
      type: 'function_response'
    }))

    return {
      role,
      toolResults
    }
  }

  // ============================================================================
  // Part Processing Utilities
  // ============================================================================

  _extractTextParts (parts) {
    return parts
      .filter(part => part.text)
      .map(part => part.text)
  }

  _groupPartsByRole (parts) {
    const grouped = {
      reasoning: '',
      assistant: ''
    }

    for (const part of parts) {
      if (!part.text) continue

      if (part.thought === true) {
        grouped.reasoning += part.text
      } else {
        grouped.assistant += part.text
      }
    }

    return grouped
  }

  _hasThoughtParts (parts) {
    return parts.some(part => part.thought === true)
  }

  // ============================================================================
  // Role Utilities
  // ============================================================================

  _determineRole (candidate, parts = []) {
    // Check parts for thought indicators
    if (this._hasThoughtParts(parts)) {
      return ROLES.REASONING
    }

    // Extract role from various possible locations
    const rawRole = candidate.role ||
                    candidate.content?.role ||
                    candidate[0]?.content?.role

    return this._normalizeRole(rawRole)
  }

  _normalizeRole (role) {
    if (role === ROLES.MODEL) return ROLES.ASSISTANT
    if (role === ROLES.ASSISTANT) return ROLES.ASSISTANT
    if (role === ROLES.USER) return ROLES.USER
    if (role === ROLES.REASONING) return ROLES.REASONING
    return ROLES.USER // default
  }

  // ============================================================================
  // Extraction Utilities
  // ============================================================================

  _extractMetrics (response) {
    const metrics = {}
    const tokenUsage = response.usageMetadata

    if (!tokenUsage) return metrics

    if (tokenUsage.promptTokenCount) {
      metrics.inputTokens = tokenUsage.promptTokenCount
    }

    if (tokenUsage.candidatesTokenCount) {
      metrics.outputTokens = tokenUsage.candidatesTokenCount
    }

    const totalTokens = tokenUsage.totalTokenCount ||
                       (tokenUsage.promptTokenCount || 0) + (tokenUsage.candidatesTokenCount || 0)
    if (totalTokens) {
      metrics.totalTokens = totalTokens
    }

    return metrics
  }

  _extractMetadata (config) {
    if (!config) return {}

    const fieldMap = {
      temperature: 'temperature',
      top_p: 'topP',
      top_k: 'topK',
      candidate_count: 'candidateCount',
      max_output_tokens: 'maxOutputTokens',
      stop_sequences: 'stopSequences',
      response_logprobs: 'responseLogprobs',
      logprobs: 'logprobs',
      presence_penalty: 'presencePenalty',
      frequency_penalty: 'frequencyPenalty',
      seed: 'seed',
      response_mime_type: 'responseMimeType',
      safety_settings: 'safetySettings',
      automatic_function_calling: 'automaticFunctionCalling'
    }

    const metadata = {}
    for (const [metadataKey, configKey] of Object.entries(fieldMap)) {
      metadata[metadataKey] = config[configKey] ?? null
    }

    return metadata
  }
}

// ============================================================================
// Module-level Utilities
// ============================================================================

function getOperation (methodName) {
  return methodName.includes('embed') ? 'embedding' : 'llm'
}

module.exports = GenAiLLMObsPlugin

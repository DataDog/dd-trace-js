'use strict'

// Constants for role mapping
const ROLES = {
  MODEL: 'model',
  ASSISTANT: 'assistant',
  USER: 'user',
  REASONING: 'reasoning'
}

/**
 * Get the operation type from the method name
 * @param {string} methodName
 * @returns {'embedding' | 'llm'}
 */
function getOperation (methodName) {
  return methodName.includes('embed') ? 'embedding' : 'llm'
}

/**
 * Extract text parts from an array of parts
 * @param {Array<{text?: string}>} parts
 * @returns {string[]}
 */
function extractTextParts (parts) {
  return parts
    .filter(part => part.text)
    .map(part => part.text)
}

/**
 * Group parts by role (reasoning vs assistant)
 * @param {Array<{text?: string, thought?: boolean}>} parts
 * @returns {{reasoning: string, assistant: string}}
 */
function groupPartsByRole (parts) {
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

/**
 * Check if parts contain thought/reasoning content
 * @param {Array<{thought?: boolean}>} parts
 * @returns {boolean}
 */
function hasThoughtParts (parts) {
  return parts.some(part => part.thought === true)
}

/**
 * Determine the role from a candidate and its parts
 * @param {object} candidate
 * @param {Array<{thought?: boolean}>} parts
 * @returns {string}
 */
function determineRole (candidate, parts = []) {
  // Check parts for thought indicators
  if (hasThoughtParts(parts)) {
    return ROLES.REASONING
  }

  // Extract role from various possible locations
  const rawRole = candidate.role ||
                  candidate.content?.role ||
                  candidate[0]?.content?.role

  return normalizeRole(rawRole)
}

/**
 * Normalize role to standard values
 * @param {string} role
 * @returns {string}
 */
function normalizeRole (role) {
  if (role === ROLES.MODEL) return ROLES.ASSISTANT
  if (role === ROLES.ASSISTANT) return ROLES.ASSISTANT
  if (role === ROLES.USER) return ROLES.USER
  if (role === ROLES.REASONING) return ROLES.REASONING
  return ROLES.USER // default
}

/**
 * Extract metrics from response
 * @param {object} response
 * @returns {object}
 */
function extractMetrics (response) {
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

/**
 * Extract metadata from config
 * @param {object} config
 * @returns {object}
 */
function extractMetadata (config) {
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

/**
 * Format function call message
 * @param {Array} parts
 * @param {Array} functionCalls
 * @param {string} role
 * @returns {object}
 */
function formatFunctionCallMessage (parts, functionCalls, role) {
  const toolCalls = functionCalls.map(part => ({
    name: part.functionCall.name,
    arguments: part.functionCall.args,
    toolId: part.functionCall.id || '',
    type: 'function_call'
  }))

  const textParts = extractTextParts(parts)
  const content = textParts.length > 0 ? textParts.join('\n') : undefined
  const message = { role, toolCalls }

  if (content) message.content = content

  return message
}

/**
 * Format function response message
 * @param {Array} functionResponses
 * @param {string} role
 * @returns {object}
 */
function formatFunctionResponseMessage (functionResponses, role) {
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

/**
 * Aggregate streaming chunks into a single response
 * @param {Array} chunks
 * @returns {object}
 */
function aggregateStreamingChunks (chunks) {
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

/**
 * Format a content object into a message
 * @param {object} content
 * @returns {object}
 */
function formatContentObject (content) {
  const parts = content.parts || []
  const role = determineRole(content, parts)

  // Check if this is a thought/reasoning part
  if (hasThoughtParts(parts)) {
    return {
      role: ROLES.REASONING,
      content: extractTextParts(parts).join('\n')
    }
  }

  // Check for function calls
  const functionCalls = parts.filter(part => part.functionCall)
  if (functionCalls.length > 0) {
    return formatFunctionCallMessage(parts, functionCalls, role)
  }

  // Check for function responses
  const functionResponses = parts.filter(part => part.functionResponse)
  if (functionResponses.length > 0) {
    return formatFunctionResponseMessage(functionResponses, role)
  }

  // Regular text content
  return {
    role,
    content: extractTextParts(parts).join('\n')
  }
}

/**
 * Format input messages from contents
 * @param {*} contents
 * @returns {Array}
 */
function formatInputMessages (contents) {
  if (!contents) return []

  const contentArray = Array.isArray(contents) ? contents : [contents]
  const messages = []

  for (const content of contentArray) {
    if (typeof content === 'string') {
      messages.push({ role: ROLES.USER, content })
    } else if (content.text) {
      messages.push({ role: ROLES.USER, content: content.text })
    } else if (content.parts) {
      const message = formatContentObject(content)
      if (message) messages.push(message)
    } else {
      messages.push({ role: ROLES.USER, content: JSON.stringify(content) })
    }
  }

  return messages
}

/**
 * Format embedding input from contents
 * @param {*} contents
 * @returns {Array}
 */
function formatEmbeddingInput (contents) {
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

/**
 * Format a non-streaming candidate into messages
 * @param {object} candidate
 * @returns {Array}
 */
function formatNonStreamingCandidate (candidate) {
  const messages = []
  const content = Array.isArray(candidate) ? candidate[0].content : candidate.content

  if (!content?.parts) return messages

  const { parts } = content

  // Check for function calls
  const functionCalls = parts.filter(part => part.functionCall)
  if (functionCalls.length > 0) {
    messages.push(formatFunctionCallMessage(parts, functionCalls, ROLES.ASSISTANT))
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
  const partsByRole = groupPartsByRole(parts)

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

/**
 * Format streaming output from response
 * @param {object} response
 * @returns {Array}
 */
function formatStreamingOutput (response) {
  const messages = []
  const messagesByRole = new Map()

  for (const candidate of response.candidates) {
    const content = Array.isArray(candidate) ? candidate[0].content : candidate.content
    if (!content?.parts) continue

    // Skip special cases in streaming (handle them as non-streaming)
    if (content.parts.some(part => part.functionCall ||
                                   part.executableCode ||
                                   part.codeExecutionResult)) {
      messages.push(...formatNonStreamingCandidate(candidate))
      continue
    }

    // Accumulate text parts by role
    const partsByRole = groupPartsByRole(content.parts)

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

/**
 * Format non-streaming output from response
 * @param {object} response
 * @returns {Array}
 */
function formatNonStreamingOutput (response) {
  const messages = []

  for (const candidate of response.candidates) {
    messages.push(...formatNonStreamingCandidate(candidate))
  }

  return messages.length > 0 ? messages : [{ content: '' }]
}

/**
 * Format output messages from response
 * @param {object} response
 * @param {boolean} isStreaming
 * @returns {Array}
 */
function formatOutputMessages (response, isStreaming = false) {
  if (!response?.candidates?.length) {
    return [{ content: '' }]
  }

  if (isStreaming) {
    return formatStreamingOutput(response)
  }

  return formatNonStreamingOutput(response)
}

/**
 * Format embedding output from response
 * @param {object} response
 * @returns {string}
 */
function formatEmbeddingOutput (response) {
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

module.exports = {
  getOperation,
  extractMetrics,
  extractMetadata,
  aggregateStreamingChunks,
  formatInputMessages,
  formatEmbeddingInput,
  formatOutputMessages,
  formatEmbeddingOutput
}

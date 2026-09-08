'use strict'

const LLMObsPlugin = require('../base')
const {
  PROMPT_TRACKING_INSTRUMENTATION_METHOD,
  PROMPT_MULTIMODAL,
  INSTRUMENTATION_METHOD_AUTO,
} = require('../../constants/tags')
const { audioMimeTypeFromFormat, formatAudioPart, safeJsonParse } = require('../../util')
const {
  AUDIO_MIME_TYPES,
  COMMON_METADATA_KEYS,
  OPENAI_METADATA_RESPONSE_KEYS,
  OPENAI_METADATA_CHAT_KEYS,
  OPENAI_METADATA_COMPLETION_KEYS,
  IMAGE_FALLBACK,
} = require('./constants')
const {
  extractChatTemplateFromInstructions,
  normalizePromptVariables,
  extractContentParts,
  hasMultimodalInputs,
  getOpenAIModelProvider,
  getOpenAIToolDefinitions,
  getResponseImageReference,
  getResponseFileReference,
} = require('./utils')

function isIterable (obj) {
  if (obj == null) {
    return false
  }
  return typeof obj[Symbol.iterator] === 'function'
}

function normalizeChatInputMessages (messages) {
  if (!Array.isArray(messages)) return []

  return messages.map(message => {
    if (!message || typeof message !== 'object') {
      return { role: '', content: '' }
    }

    let content = message.content
    let audioParts
    if (Array.isArray(content)) {
      ({ content, audioParts } = extractContentParts(content))
    } else if (content == null) {
      content = ''
    }

    const normalizedMessage = {
      role: message.role ?? '',
      content,
    }
    if (audioParts?.length) normalizedMessage.audioParts = audioParts

    const toolCalls = []
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (!toolCall || typeof toolCall !== 'object') continue
        const fn = toolCall.function
        const custom = toolCall.custom
        const rawArguments = fn?.arguments ?? custom?.input
        toolCalls.push({
          name: fn?.name ?? custom?.name ?? '',
          arguments: typeof rawArguments === 'string' ? safeJsonParse(rawArguments, {}) : (rawArguments ?? {}),
          toolId: toolCall.id ?? '',
          type: toolCall.type ?? 'function',
        })
      }
    }

    if (message.function_call && typeof message.function_call === 'object') {
      const { name, arguments: rawArguments } = message.function_call
      toolCalls.push({
        name: name ?? '',
        arguments: typeof rawArguments === 'string' ? safeJsonParse(rawArguments, {}) : (rawArguments ?? {}),
      })
    }

    if (message.role === 'tool') {
      normalizedMessage.content = ''
      normalizedMessage.toolResults = [{
        name: message.name ?? '',
        result: content ? String(content) : '',
        toolId: message.tool_call_id ?? '',
        type: message.type ?? 'tool_result',
      }]
    }

    if (toolCalls.length) normalizedMessage.toolCalls = toolCalls
    return normalizedMessage
  })
}

class OpenAiLLMObsPlugin extends LLMObsPlugin {
  static id = 'openai'
  static integration = 'openai'
  static prefix = 'tracing:apm:openai:request'

  getLLMObsSpanRegisterOptions (ctx) {
    const resource = ctx.methodName
    const methodName = gateResource(normalizeOpenAIResourceName(resource))
    if (!methodName) return // we will not trace all openai methods for llmobs

    const inputs = ctx.args[0] // completion, chat completion, embeddings, and responses take one argument
    const operation = getOperation(methodName)
    const kind = operation === 'embedding' ? 'embedding' : 'llm'

    const { modelProvider, client } = this._getModelProviderAndClient(ctx.basePath)

    const name = `${client}.${methodName}`

    return {
      modelProvider,
      modelName: inputs.model,
      kind,
      name,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const resource = ctx.methodName
    const methodName = gateResource(normalizeOpenAIResourceName(resource))
    if (!methodName) return // we will not trace all openai methods for llmobs

    const inputs = ctx.args[0] ?? {}
    const response = ctx.result?.data // no result if error
    const error = !!span.context().getTag('error')

    const operation = getOperation(methodName)

    if (operation === 'completion') {
      this._tagCompletion(span, inputs, response, error)
    } else if (operation === 'chat') {
      this._tagChatCompletion(span, inputs, response, error)
    } else if (operation === 'embedding') {
      this._tagEmbedding(span, inputs, response, error)
    } else if (operation === 'response') {
      this.#tagResponse(span, inputs, response, error)
    }

    if (!error) {
      const metrics = this._extractMetrics(response)
      this._tagger.tagMetrics(span, metrics)

      const responseModel = response?.model
      if (responseModel) {
        // override the model name with the response model (more accurate)
        this._tagger.tagModelName(span, responseModel)
      }
    }
  }

  _getModelProviderAndClient (baseUrl = '') {
    const modelProvider = getOpenAIModelProvider(baseUrl)
    if (modelProvider === 'azure_openai') return { modelProvider, client: 'AzureOpenAI' }
    if (modelProvider === 'deepseek') return { modelProvider, client: 'DeepSeek' }
    return { modelProvider, client: 'OpenAI' }
  }

  _extractMetrics (response) {
    const metrics = {}
    const tokenUsage = response?.usage

    if (tokenUsage) {
      // Responses API uses input_tokens, Chat/Completions use prompt_tokens
      const inputTokens = tokenUsage.input_tokens ?? tokenUsage.prompt_tokens ?? 0
      if (inputTokens !== undefined) metrics.inputTokens = inputTokens

      // Responses API uses output_tokens, Chat/Completions use completion_tokens
      const outputTokens = tokenUsage.output_tokens ?? tokenUsage.completion_tokens ?? 0
      if (outputTokens !== undefined) metrics.outputTokens = outputTokens

      const totalTokens = tokenUsage.total_tokens || (inputTokens + outputTokens)
      if (totalTokens !== undefined) metrics.totalTokens = totalTokens

      const details = tokenUsage.prompt_tokens_details ?? tokenUsage.input_tokens_details
      if (details?.cached_tokens != null) metrics.cacheReadTokens = details.cached_tokens
      if (details?.cache_write_tokens != null) metrics.cacheWriteTokens = details.cache_write_tokens

      const reasoning = (tokenUsage.output_tokens_details ?? tokenUsage.completion_tokens_details)?.reasoning_tokens
      if (reasoning != null) metrics.reasoningOutputTokens = reasoning
    }

    return metrics
  }

  _tagEmbedding (span, inputs, response, error) {
    const { model, ...parameters } = inputs

    const metadata = {
      encoding_format: parameters.encoding_format || 'float',
    }
    if (inputs.dimensions) metadata.dimensions = inputs.dimensions
    this._tagger.tagMetadata(span, metadata)

    let embeddingInputs = inputs.input
    if (!Array.isArray(embeddingInputs)) embeddingInputs = [embeddingInputs]
    const embeddingInput = embeddingInputs.map(input => ({ text: input }))

    if (error) {
      this._tagger.tagEmbeddingIO(span, embeddingInput)
      return
    }

    const float = Array.isArray(response.data[0].embedding)
    let embeddingOutput
    if (float) {
      const embeddingDim = response.data[0].embedding.length
      embeddingOutput = `[${response.data.length} embedding(s) returned with size ${embeddingDim}]`
    } else {
      embeddingOutput = `[${response.data.length} embedding(s) returned]`
    }

    this._tagger.tagEmbeddingIO(span, embeddingInput, embeddingOutput)
  }

  _tagCompletion (span, inputs, response, error) {
    let { prompt, model, ...parameters } = inputs
    if (!Array.isArray(prompt)) prompt = [prompt]

    const completionInput = prompt.map(p => ({ content: p }))

    const completionOutput = error
      ? [{ content: '' }]
      : (Array.isArray(response?.choices) ? response.choices : []).map(choice => ({ content: choice?.text ?? '' }))

    this._tagger.tagLLMIO(span, completionInput, completionOutput)
    this._tagger.tagMetadata(
      span,
      getAllowedMetadata(parameters, COMMON_METADATA_KEYS, OPENAI_METADATA_COMPLETION_KEYS)
    )
  }

  _tagChatCompletion (span, inputs, response, error) {
    const { messages, model, ...parameters } = inputs

    this._tagger.tagMetadata(span, getAllowedMetadata(parameters, COMMON_METADATA_KEYS, OPENAI_METADATA_CHAT_KEYS))

    const inputMessages = normalizeChatInputMessages(messages)
    const defs = [
      ...getOpenAIToolDefinitions(inputs.tools),
      ...getOpenAIToolDefinitions(inputs.functions),
    ]
    if (defs.length) this._tagger.tagToolDefinitions(span, defs)

    if (error) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    const outputMessages = []
    const { choices } = response ?? {}
    if (!isIterable(choices)) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    // Output audio (non-streamed) is returned in the requested format; chat-completions
    const outputAudioFormat = inputs.audio?.format

    for (const choice of choices) {
      const message = choice?.message || choice?.delta || {}
      let content = message.content || ''
      const role = message.role

      const audio = message.audio
      let audioParts
      if (audio) {
        if (audio.data) {
          audioParts = [formatAudioPart(audio.data, audioMimeTypeFromFormat(outputAudioFormat, AUDIO_MIME_TYPES))]
        }
        // gpt-audio* / gpt-4o-audio-preview return null content; surface the transcript as text.
        if (!content) content = audio.transcript || ''
      }

      if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
        outputMessages.push({ role: 'reasoning', content: String(message.reasoning_content) })
      }

      const outputMessage = { content, role }
      if (audioParts) outputMessage.audioParts = audioParts

      if (message.function_call) {
        outputMessage.toolCalls = [{
          name: message.function_call.name ?? '',
          arguments: safeJsonParse(message.function_call.arguments, {}),
        }]
      } else if (Array.isArray(message.tool_calls)) {
        const toolCallsInfo = []
        for (const toolCall of message.tool_calls) {
          if (!toolCall || typeof toolCall !== 'object') continue
          const fn = toolCall.function
          const custom = toolCall.custom
          const rawArguments = fn?.arguments ?? custom?.input
          toolCallsInfo.push({
            arguments: typeof rawArguments === 'string' ? safeJsonParse(rawArguments, {}) : (rawArguments ?? {}),
            name: fn?.name ?? custom?.name ?? '',
            toolId: toolCall.id ?? '',
            type: toolCall.type ?? 'function',
          })
        }
        if (toolCallsInfo.length) outputMessage.toolCalls = toolCallsInfo
      }

      outputMessages.push(outputMessage)
    }

    this._tagger.tagLLMIO(span, inputMessages, outputMessages)
  }

  #tagResponse (span, inputs, response, error) {
    const { model, ...parameters } = inputs
    let input = inputs.input
    const inputMessages = []

    if (inputs.instructions) {
      inputMessages.push({ role: 'system', content: inputs.instructions })
    }

    if (!input && inputs.prompt && response?.instructions) {
      input = response.instructions
    }

    if (Array.isArray(input)) {
      for (const item of input) {
        if (!item || typeof item !== 'object') continue
        const { role, content: itemContent } = item
        if (role != null && itemContent != null) {
          let content = ''
          if (Array.isArray(item.content)) {
            for (const contentPart of item.content) {
              if (!contentPart || typeof contentPart !== 'object') continue
              content += String(contentPart.text ?? '')
              content += String(contentPart.refusal ?? '')
              if (contentPart.type === 'input_image') {
                content += getResponseImageReference(contentPart)
              } else if (contentPart.type === 'input_file') {
                content += getResponseFileReference(contentPart)
              }
            }
          } else {
            content = itemContent
          }
          if (content) {
            inputMessages.push({ role, content: String(content) })
          }
        } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          const rawArguments = item.arguments ?? item.input ?? '{}'
          inputMessages.push({
            role: 'assistant',
            toolCalls: [{
              toolId: String(item.call_id ?? ''),
              name: String(item.name ?? ''),
              arguments: safeJsonParse(String(rawArguments), {}),
              type: String(item.type),
            }],
          })
        } else if (item.type === 'function_call_output') {
          let output = item.output
          if (Array.isArray(output)) {
            output = output.reduce((result, part) => {
              if (part?.type !== 'input_text') return result
              return result + String(part.text ?? '')
            }, '')
          } else if (typeof output !== 'string') {
            output = safeJsonStringify(output)
          }
          inputMessages.push({
            role: 'user',
            toolResults: [{
              toolId: String(item.call_id ?? ''),
              result: output ? String(output) : '',
              name: String(item.name ?? ''),
              type: item.type,
            }],
          })
        } else if (item.type === 'computer_call_output') {
          inputMessages.push({ role: 'user', content: getResponseImageReference(item.output) })
        }
      }
    } else if (input != null) {
      inputMessages.push({ role: 'user', content: input })
    }

    this._tagger.tagMetadata(span, getAllowedMetadata(parameters, COMMON_METADATA_KEYS, OPENAI_METADATA_RESPONSE_KEYS))
    const toolDefinitions = getOpenAIToolDefinitions(inputs.tools)

    if (error) {
      if (toolDefinitions.length) this._tagger.tagToolDefinitions(span, toolDefinitions)
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    const outputMessages = []
    const outputToolDefinitions = []

    if (typeof response?.output === 'string') {
      outputMessages.push({ role: 'assistant', content: response.output })
    } else if (Array.isArray(response?.output)) {
      for (const item of response.output) {
        if (!item || typeof item !== 'object') {
          outputMessages.push({ role: 'assistant', content: safeJsonStringify(item).slice(0, 4096) })
        } else if (item.type === 'message') {
          let content = ''
          if (Array.isArray(item.content)) {
            for (const contentPart of item.content) {
              if (!contentPart || typeof contentPart !== 'object') continue
              content += String(contentPart.text ?? '')
              content += String(contentPart.refusal ?? '')
            }
          } else if (typeof item.content === 'string') {
            content = item.content
          }
          const outputMsg = { role: item.role ?? 'assistant', content }
          if (Array.isArray(item.tool_calls)) {
            outputMsg.toolCalls = item.tool_calls.map(toolCall => ({
              toolId: toolCall?.id ?? '',
              name: toolCall?.function?.name ?? toolCall?.custom?.name ?? toolCall?.name ?? '',
              arguments: safeJsonParse(
                String(toolCall?.function?.arguments ?? toolCall?.custom?.input ?? toolCall?.arguments ?? '{}'),
                {}
              ),
              type: toolCall?.type ?? 'function',
            }))
          }
          outputMessages.push(outputMsg)
        } else if (item.type === 'reasoning') {
          outputMessages.push({
            role: 'reasoning',
            content: safeJsonStringify({
              summary: item.summary ?? '',
              encrypted_content: item.encrypted_content ?? '',
              id: item.id ?? '',
            }),
          })
        } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          const rawArguments = item.input || item.arguments || '{}'
          outputMessages.push({
            role: 'assistant',
            toolCalls: [{
              toolId: String(item.call_id ?? ''),
              name: String(item.name ?? ''),
              arguments: safeJsonParse(String(rawArguments), {}),
              type: String(item.type ?? 'function'),
            }],
          })
        } else if (item.type === 'mcp_call') {
          const callId = String(item.id ?? '')
          const name = String(item.name ?? '')
          outputMessages.push({
            role: 'assistant',
            content: '',
            toolCalls: [{
              toolId: callId,
              name,
              arguments: safeJsonParse(String(item.arguments ?? '{}'), {}),
              type: 'mcp_call',
            }],
            toolResults: [{
              name,
              result: String(item.output ?? ''),
              toolId: callId,
              type: 'mcp_tool_result',
            }],
          })
        } else if (item.type === 'mcp_list_tools') {
          outputToolDefinitions.push(...getOpenAIToolDefinitions(item.tools))
        } else if (item.type === 'image_generation_call') {
          outputMessages.push({ role: 'assistant', content: IMAGE_FALLBACK })
        } else if (item.type === 'computer_call_output') {
          outputMessages.push({ role: 'user', content: getResponseImageReference(item.output) })
        } else {
          outputMessages.push({ role: 'assistant', content: safeJsonStringify(item).slice(0, 4096) })
        }
      }
    } else if (response?.output_text) {
      outputMessages.push({ role: 'assistant', content: response.output_text })
    } else {
      outputMessages.push({ role: 'assistant', content: '' })
    }

    this._tagger.tagLLMIO(span, inputMessages, outputMessages)
    if (toolDefinitions.length || outputToolDefinitions.length) {
      this._tagger.tagToolDefinitions(span, [...toolDefinitions, ...outputToolDefinitions])
    }

    // Handle prompt tracking for reusable prompts
    if (inputs.prompt && response?.prompt) {
      const { id, version } = response.prompt // ResponsePrompt
      if (id && version) {
        const normalizedVariables = normalizePromptVariables(inputs.prompt.variables)
        const chatTemplate = extractChatTemplateFromInstructions(response.instructions, normalizedVariables)
        this._tagger.tagPrompt(span, {
          id,
          version,
          variables: normalizedVariables,
          template: chatTemplate,
        }, true)
        const tags = { [PROMPT_TRACKING_INSTRUMENTATION_METHOD]: INSTRUMENTATION_METHOD_AUTO }
        if (hasMultimodalInputs(inputs.prompt.variables)) {
          tags[PROMPT_MULTIMODAL] = 'true'
        }
        this._tagger.tagSpanTags(span, tags)
      }
    }

    const outputMetadata = {}
    for (const key of ['temperature', 'max_output_tokens', 'top_p', 'tool_choice', 'truncation', 'text', 'user']) {
      if (response?.[key] !== undefined) outputMetadata[key] = response[key]
    }
    this._tagger.tagMetadata(span, outputMetadata)
  }
}

// TODO: this will be moved to the APM integration
function normalizeOpenAIResourceName (resource) {
  switch (resource) {
    // completions
    case 'completions.create':
      return 'createCompletion'

    // chat completions
    case 'chat.completions.create':
      return 'createChatCompletion'

    // embeddings
    case 'embeddings.create':
      return 'createEmbedding'

    // responses
    case 'responses.create':
      return 'createResponse'

    default:
      return resource
  }
}

function gateResource (resource) {
  return ['createCompletion', 'createChatCompletion', 'createEmbedding', 'createResponse'].includes(resource)
    ? resource
    : undefined
}

function getOperation (resource) {
  switch (resource) {
    case 'createCompletion':
      return 'completion'
    case 'createChatCompletion':
      return 'chat'
    case 'createEmbedding':
      return 'embedding'
    case 'createResponse':
      return 'response'
    default:
      // should never happen
      return 'unknown'
  }
}

function getAllowedMetadata (parameters, ...keySets) {
  const allowedKeys = new Set(keySets.flatMap(keySet => [...keySet]))
  return Object.fromEntries(
    Object.entries(parameters).filter(([key, value]) => allowedKeys.has(key) && value !== undefined)
  )
}

function safeJsonStringify (value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

module.exports = OpenAiLLMObsPlugin

'use strict'

const LLMObsPlugin = require('../base')
const { extractChatTemplateFromInstructions, normalizePromptVariables, extractTextFromContentItem } = require('./utils')

const allowedParamKeys = new Set([
  'max_output_tokens',
  'temperature',
  'stream',
  'reasoning'
])

function isIterable (obj) {
  if (obj == null) {
    return false
  }
  return typeof obj[Symbol.iterator] === 'function'
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
      name
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const resource = ctx.methodName
    const methodName = gateResource(normalizeOpenAIResourceName(resource))
    if (!methodName) return // we will not trace all openai methods for llmobs

    const inputs = ctx.args[0] // completion, chat completion, and embeddings take one argument
    const response = ctx.result?.data // no result if error
    const error = !!span.context()._tags.error

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

      const responseModel = response.model
      if (responseModel) {
        // override the model name with the response model (more accurate)
        this._tagger.tagModelName(span, responseModel)
      }
    }
  }

  _getModelProviderAndClient (baseUrl = '') {
    if (baseUrl.includes('azure')) {
      return { modelProvider: 'azure_openai', client: 'AzureOpenAI' }
    } else if (baseUrl.includes('deepseek')) {
      return { modelProvider: 'deepseek', client: 'DeepSeek' }
    }
    return { modelProvider: 'openai', client: 'OpenAI' }
  }

  _extractMetrics (response) {
    const metrics = {}
    const tokenUsage = response.usage

    if (tokenUsage) {
      // Responses API uses input_tokens, Chat/Completions use prompt_tokens
      const inputTokens = tokenUsage.input_tokens ?? tokenUsage.prompt_tokens ?? 0
      if (inputTokens !== undefined) metrics.inputTokens = inputTokens

      // Responses API uses output_tokens, Chat/Completions use completion_tokens
      const outputTokens = tokenUsage.output_tokens ?? tokenUsage.completion_tokens ?? 0
      if (outputTokens !== undefined) metrics.outputTokens = outputTokens

      const totalTokens = tokenUsage.total_tokens || (inputTokens + outputTokens)
      if (totalTokens !== undefined) metrics.totalTokens = totalTokens

      // Cache tokens - Responses API uses input_tokens_details, Chat/Completions use prompt_tokens_details
      // For Responses API, always include cache tokens (even if 0)
      // For Chat API, only include if > 0
      if (tokenUsage.input_tokens_details) {
        // Responses API - always include
        const cacheReadTokens = tokenUsage.input_tokens_details.cached_tokens
        if (cacheReadTokens !== undefined) metrics.cacheReadTokens = cacheReadTokens
      } else if (tokenUsage.prompt_tokens_details) {
        // Chat/Completions API - only include if > 0
        const cacheReadTokens = tokenUsage.prompt_tokens_details.cached_tokens
        if (cacheReadTokens != null) {
          metrics.cacheReadTokens = cacheReadTokens
        }
      }
      // Reasoning tokens - Responses API returns `output_tokens_details`, `completion_tokens_details`
      const reasoningOutputObject = tokenUsage.output_tokens_details ?? tokenUsage.completion_tokens_details
      const reasoningOutputTokens = reasoningOutputObject?.reasoning_tokens ?? 0
      if (reasoningOutputTokens !== undefined) metrics.reasoningOutputTokens = reasoningOutputTokens
    }

    return metrics
  }

  _tagEmbedding (span, inputs, response, error) {
    const { model, ...parameters } = inputs

    const metadata = {
      encoding_format: parameters.encoding_format || 'float'
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

    const completionOutput = error ? [{ content: '' }] : response.choices.map(choice => ({ content: choice.text }))

    this._tagger.tagLLMIO(span, completionInput, completionOutput)
    this._tagger.tagMetadata(span, parameters)
  }

  _tagChatCompletion (span, inputs, response, error) {
    const { messages, model, ...parameters } = inputs

    const metadata = Object.entries(parameters).reduce((obj, [key, value]) => {
      if (!['tools', 'functions'].includes(key)) {
        obj[key] = value
      }

      return obj
    }, {})

    this._tagger.tagMetadata(span, metadata)

    if (error) {
      this._tagger.tagLLMIO(span, messages, [{ content: '' }])
      return
    }

    const outputMessages = []
    const { choices } = response
    if (!isIterable(choices)) {
      this._tagger.tagLLMIO(span, messages, [{ content: '' }])
      return
    }

    for (const choice of choices) {
      const message = choice.message || choice.delta
      const content = message.content || ''
      const role = message.role

      if (message.function_call) {
        const functionCallInfo = {
          name: message.function_call.name,
          arguments: JSON.parse(message.function_call.arguments)
        }
        outputMessages.push({ content, role, toolCalls: [functionCallInfo] })
      } else if (message.tool_calls) {
        const toolCallsInfo = []
        for (const toolCall of message.tool_calls) {
          const toolCallInfo = {
            arguments: JSON.parse(toolCall.function.arguments),
            name: toolCall.function.name,
            toolId: toolCall.id,
            type: toolCall.type
          }
          toolCallsInfo.push(toolCallInfo)
        }
        outputMessages.push({ content, role, toolCalls: toolCallsInfo })
      } else {
        outputMessages.push({ content, role })
      }
    }

    this._tagger.tagLLMIO(span, messages, outputMessages)
  }

  #tagResponse (span, inputs, response, error) {
    // Tag metadata - use allowlist approach for request parameters

    const { model, ...parameters } = inputs
    let input = inputs.input

    // Create input messages
    const inputMessages = []

    // Add system message if instructions exist
    if (inputs.instructions) {
      inputMessages.push({ role: 'system', content: inputs.instructions })
    }

    // For reusable prompts, use response.instructions if no explicit input is provided
    if (!input && inputs.prompt && response?.instructions) {
      input = response.instructions
    }

    // Handle input - can be string or array of mixed messages
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item.type === 'message') {
          // Handle instruction messages (from response.instructions for reusable prompts)
          const role = item.role
          if (!role) continue

          let content = ''
          if (Array.isArray(item.content)) {
            const textParts = item.content
              .map(extractTextFromContentItem)
              .filter(Boolean)
            content = textParts.join('')
          } else if (typeof item.content === 'string') {
            content = item.content
          }

          if (content) {
            inputMessages.push({ role, content })
          }
        } else if (item.type === 'function_call') {
          // Function call: convert to message with tool_calls
          // Parse arguments if it's a JSON string
          let parsedArgs = item.arguments
          if (typeof parsedArgs === 'string') {
            try {
              parsedArgs = JSON.parse(parsedArgs)
            } catch {
              parsedArgs = {}
            }
          }
          inputMessages.push({
            role: 'assistant',
            toolCalls: [{
              toolId: item.call_id,
              name: item.name,
              arguments: parsedArgs,
              type: item.type
            }]
          })
        } else if (item.type === 'function_call_output') {
          // Function output: convert to user message with tool_results
          inputMessages.push({
            role: 'user',
            toolResults: [{
              toolId: item.call_id,
              result: item.output,
              name: item.name || '',
              type: item.type
            }]
          })
        } else if (item.role && item.content) {
          // Regular message
          inputMessages.push({ role: item.role, content: item.content })
        }
      }
    } else {
      // Simple string input
      inputMessages.push({ role: 'user', content: input })
    }

    const inputMetadata = Object.entries(parameters).reduce((obj, [key, value]) => {
      if (allowedParamKeys.has(key)) {
        obj[key] = value
      }
      return obj
    }, {})

    this._tagger.tagMetadata(span, inputMetadata)

    if (error) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    // Create output messages
    const outputMessages = []

    // Handle output - can be string (streaming) or array of message objects (non-streaming)
    if (typeof response.output === 'string') {
      // Simple text output (streaming)
      outputMessages.push({ role: 'assistant', content: response.output })
    } else if (Array.isArray(response.output)) {
      // Array output - process all items to extract reasoning, messages, and tool calls
      // Non-streaming: array of items (messages, function_calls, or reasoning)
      for (const item of response.output) {
        // Handle reasoning type (reasoning responses)
        if (item.type === 'reasoning') {
          outputMessages.push({
            role: 'reasoning',
            content: JSON.stringify({
              summary: item.summary ?? [],
              encrypted_content: item.encrypted_content ?? null,
              id: item.id ?? ''
            })
          })
        } else if (item.type === 'function_call') {
          // Handle function_call type (responses API tool calls)
          let args = item.arguments
          // Parse arguments if it's a JSON string
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args)
            } catch {
              args = {}
            }
          }
          outputMessages.push({
            role: 'assistant',
            toolCalls: [{
              toolId: item.call_id,
              name: item.name,
              arguments: args,
              type: item.type
            }]
          })
        } else {
          // Handle regular message objects
          const outputMsg = { role: item.role || 'assistant', content: '' }

          // Extract content from message
          if (Array.isArray(item.content)) {
            // Content is array of content parts
            // For responses API, text content has type 'output_text', not 'text'
            const textParts = item.content
              .filter(c => c.type === 'output_text')
              .map(c => c.text)
            outputMsg.content = textParts.join('')
          } else if (typeof item.content === 'string') {
            outputMsg.content = item.content
          }

          // Extract tool calls if present in message.tool_calls
          if (Array.isArray(item.tool_calls)) {
            outputMsg.toolCalls = item.tool_calls.map(tc => {
              let args = tc.function?.arguments || tc.arguments
              // Parse arguments if it's a JSON string
              if (typeof args === 'string') {
                try {
                  args = JSON.parse(args)
                } catch {
                  args = {}
                }
              }
              return {
                toolId: tc.id,
                name: tc.function?.name || tc.name,
                arguments: args,
                type: tc.type || 'function_call'
              }
            })
          }

          outputMessages.push(outputMsg)
        }
      }
    } else if (response.output_text) {
      // Fallback: use output_text if available (for simple non-streaming responses without reasoning/tools)
      outputMessages.push({ role: 'assistant', content: response.output_text })
    } else {
      // No output
      outputMessages.push({ role: 'assistant', content: '' })
    }

    this._tagger.tagLLMIO(span, inputMessages, outputMessages)

    // Handle prompt tracking for reusable prompts
    if (inputs.prompt && response?.prompt) {
      const { id, version } = response.prompt // ResponsePrompt
      // TODO: Add proper tagger API for prompt metadata
      if (id && version) {
        const normalizedVariables = normalizePromptVariables(inputs.prompt.variables)
        const chatTemplate = extractChatTemplateFromInstructions(response.instructions, normalizedVariables)
        this._tagger._setTag(span, '_ml_obs.meta.input.prompt', {
          id,
          version,
          variables: normalizedVariables,
          chat_template: chatTemplate
        })
      }
    }

    const outputMetadata = {}

    // Add fields from response object (convert numbers to floats)
    if (response.temperature !== undefined) outputMetadata.temperature = Number(response.temperature)
    if (response.top_p !== undefined) outputMetadata.top_p = Number(response.top_p)
    if (response.tool_choice !== undefined) outputMetadata.tool_choice = response.tool_choice
    if (response.truncation !== undefined) outputMetadata.truncation = response.truncation
    if (response.text !== undefined) outputMetadata.text = response.text

    this._tagger.tagMetadata(span, outputMetadata) // update the metadata with the output metadata
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

module.exports = OpenAiLLMObsPlugin

'use strict'

const log = require('../../../../dd-trace/src/log')

const MODEL_TYPE_IDENTIFIERS = [
  'foundation-model/',
  'custom-model/',
  'provisioned-model/',
  'imported-module/',
  'prompt/',
  'endpoint/',
  'inference-profile/',
  'default-prompt-router/',
]

const PROVIDER = {
  AI21: 'AI21',
  AMAZON: 'AMAZON',
  ANTHROPIC: 'ANTHROPIC',
  COHERE: 'COHERE',
  META: 'META',
  STABILITY: 'STABILITY',
  MISTRAL: 'MISTRAL',
}

/**
 * Coerce the chunks into a single response body.
 *
 * @param {Array<{ chunk: { bytes: Buffer } }>} chunks
 * @param {string} modelProvider
 * @param {string} modelName
 * @returns {Generation | Record<never, never>}
 */
function extractTextAndResponseReasonFromStream (chunks, modelProvider, modelName) {
  const modelProviderUpper = modelProvider.toUpperCase()

  // streaming unsupported for AMAZON embedding models, COHERE embedding models, STABILITY
  if (
    (modelProviderUpper === PROVIDER.AMAZON && modelName.includes('embed')) ||
    (modelProviderUpper === PROVIDER.COHERE && modelName.includes('embed')) ||
    modelProviderUpper === PROVIDER.STABILITY
  ) {
    return {}
  }

  let message = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0

  for (const { chunk: { bytes } } of chunks) {
    const body = JSON.parse(Buffer.from(bytes).toString('utf8'))

    switch (modelProviderUpper) {
      case PROVIDER.AMAZON: {
        if (body?.outputText) {
          message += body?.outputText
          inputTokens = body?.inputTextTokenCount
          outputTokens = body?.totalOutputTextTokenCount
        } else if (body?.contentBlockDelta?.delta?.text) {
          message += body.contentBlockDelta.delta.text
        }

        break
      }
      case PROVIDER.AI21: {
        const content = body?.choices?.[0]?.delta?.content
        if (content) {
          message += content
        }

        break
      }
      case PROVIDER.ANTHROPIC: {
        if (body.completion) {
          message += body.completion
        } else if (body.delta?.text) {
          message += body.delta.text
        }

        if (body.message?.usage?.input_tokens) inputTokens = body.message.usage.input_tokens
        if (body.message?.usage?.output_tokens) outputTokens = body.message.usage.output_tokens

        break
      }
      case PROVIDER.COHERE: {
        if (body?.event_type === 'stream-end') {
          message = body.response?.text
        }

        break
      }
      case PROVIDER.META: {
        message += body?.generation
        break
      }
      case PROVIDER.MISTRAL: {
        message += body?.outputs?.[0]?.text
        break
      }
    }

    // by default, it seems newer versions of the AWS SDK include the input/output token counts in the response body
    const invocationMetrics = body['amazon-bedrock-invocationMetrics']
    if (invocationMetrics) {
      inputTokens = invocationMetrics.inputTokenCount
      outputTokens = invocationMetrics.outputTokenCount
      cacheReadTokens = invocationMetrics.cacheReadInputTokenCount
      cacheWriteTokens = invocationMetrics.cacheWriteInputTokenCount
    }
  }

  return new Generation({
    message,
    role: 'assistant',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  })
}

class Generation {
  constructor ({
    message = '',
    finishReason = '',
    choiceId = '',
    role,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    messages,
    content,
  } = {}) {
    // stringify message as it could be a single generated message as well as a list of embeddings
    this.message = typeof message === 'string' ? message : JSON.stringify(message) || ''
    this.finishReason = finishReason || ''
    this.choiceId = choiceId || undefined
    this.role = role
    this.usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }
    this.messages = messages ?? [{ content: this.message, role: this.role }]
    this.content = content
  }
}

class RequestParams {
  constructor ({
    prompt = '',
    temperature,
    topP,
    topK,
    maxTokens,
    stopSequences = [],
    inputType = '',
    truncate = '',
    stream = '',
    n,
    system,
    tools,
  } = {}) {
    this.prompt = prompt
    this.temperature = temperature
    this.topP = topP
    this.topK = topK
    this.maxTokens = maxTokens
    this.stopSequences = stopSequences || []
    this.inputType = inputType || ''
    this.truncate = truncate || ''
    this.stream = stream || ''
    this.n = n
    this.system = system
    this.tools = tools
  }
}

function parseModelId (modelId) {
  // Best effort to extract the model provider and model name from the bedrock model ID.
  // modelId can be a 1/2 period-separated string or a full AWS ARN, based on the following formats:
  // 1. Base model: "{model_provider}.{model_name}"
  // 2. Cross-region model: "{region}.{model_provider}.{model_name}"
  // 3. Other: Prefixed by AWS ARN "arn:aws{+region?}:bedrock:{region}:{account-id}:"
  //     a. Foundation model: ARN prefix + "foundation-model/{region?}.{model_provider}.{model_name}"
  //     b. Custom model: ARN prefix + "custom-model/{model_provider}.{model_name}"
  //     c. Provisioned model: ARN prefix + "provisioned-model/{model-id}"
  //     d. Imported model: ARN prefix + "imported-module/{model-id}"
  //     e. Prompt management: ARN prefix + "prompt/{prompt-id}"
  //     f. Sagemaker: ARN prefix + "endpoint/{model-id}"
  //     g. Inference profile: ARN prefix + "{application-?}inference-profile/{model-id}"
  //     h. Default prompt router: ARN prefix + "default-prompt-router/{prompt-id}"
  // If model provider cannot be inferred from the modelId formatting, then default to "custom"
  modelId = modelId.toLowerCase()
  if (!modelId.startsWith('arn:aws')) {
    const modelMeta = modelId.split('.')
    if (modelMeta.length < 2) {
      return { modelProvider: 'custom', modelName: modelMeta[0] }
    }
    return { modelProvider: modelMeta.at(-2), modelName: modelMeta.at(-1) }
  }

  for (const identifier of MODEL_TYPE_IDENTIFIERS) {
    if (!modelId.includes(identifier)) {
      continue
    }
    modelId = modelId.split(identifier).pop()
    if (['foundation-model/', 'custom-model/'].includes(identifier)) {
      const modelMeta = modelId.split('.')
      if (modelMeta.length < 2) {
        return { modelProvider: 'custom', modelName: modelId }
      }
      return { modelProvider: modelMeta.at(-2), modelName: modelMeta.at(-1) }
    }
    return { modelProvider: 'custom', modelName: modelId }
  }

  return { modelProvider: 'custom', modelName: 'custom' }
}

function extractRequestParams (params, provider) {
  const requestBody = JSON.parse(params.body)
  const modelId = params.modelId

  switch (provider.toUpperCase()) {
    case PROVIDER.AI21: {
      let userPrompt = requestBody.prompt
      if (modelId.includes('jamba')) {
        for (const message of requestBody.messages) {
          if (message.role === 'user') {
            userPrompt = message.content // Return the content of the most recent user message
          }
        }
      }
      return new RequestParams({
        prompt: userPrompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_tokens,
        stopSequences: requestBody.stop_sequences,
      })
    }
    case PROVIDER.AMAZON: {
      const prompt = requestBody.inputText
      if (modelId.includes('embed')) {
        return new RequestParams({ prompt })
      } else if (prompt !== undefined) {
        const textGenerationConfig = requestBody.textGenerationConfig || {}
        return new RequestParams({
          prompt,
          temperature: textGenerationConfig.temperature,
          topP: textGenerationConfig.topP,
          maxTokens: textGenerationConfig.maxTokenCount,
          stopSequences: textGenerationConfig.stopSequences,
        })
      } else if (Array.isArray(requestBody.messages)) {
        const inferenceConfig = requestBody.inferenceConfig || {}
        const messages = []
        if (Array.isArray(requestBody.system)) {
          for (const sysMsg of requestBody.system) {
            messages.push({
              content: sysMsg.text,
              role: 'system',
            })
          }
        }
        for (const message of requestBody.messages) {
          const textBlocks = message.content?.filter(block => block.text) || []
          if (textBlocks.length > 0) {
            let content = ''
            for (const block of textBlocks) content += block.text

            messages.push({
              content,
              role: message.role,
            })
          }
        }
        return new RequestParams({
          prompt: messages,
          temperature: inferenceConfig.temperature,
          topP: inferenceConfig.topP,
          maxTokens: inferenceConfig.maxTokens,
          stopSequences: inferenceConfig.stopSequences,
        })
      }

      return new RequestParams({ prompt })
    }
    case PROVIDER.ANTHROPIC: {
      if (Array.isArray(requestBody.messages)) {
        return new RequestParams({
          prompt: requestBody.messages,
          system: requestBody.system,
          tools: requestBody.tools,
          temperature: requestBody.temperature,
          topP: requestBody.top_p,
          maxTokens: requestBody.max_tokens_to_sample ?? requestBody.max_tokens,
          stopSequences: requestBody.stop_sequences,
        })
      }

      return new RequestParams({
        prompt: requestBody.prompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_tokens_to_sample ?? requestBody.max_tokens,
        stopSequences: requestBody.stop_sequences,
      })
    }
    case PROVIDER.COHERE: {
      if (modelId.includes('embed')) {
        return new RequestParams({
          prompt: requestBody.texts,
          inputType: requestBody.input_type,
          truncate: requestBody.truncate,
        })
      }
      return new RequestParams({
        prompt: requestBody.prompt,
        temperature: requestBody.temperature,
        topP: requestBody.p,
        maxTokens: requestBody.max_tokens,
        stopSequences: requestBody.stop_sequences,
        stream: requestBody.stream,
        n: requestBody.num_generations,
      })
    }
    case PROVIDER.META: {
      return new RequestParams({
        prompt: requestBody.prompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_gen_len,
      })
    }
    case PROVIDER.MISTRAL: {
      return new RequestParams({
        prompt: requestBody.prompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_tokens,
        stopSequences: requestBody.stop,
        topK: requestBody.top_k,
      })
    }
    case PROVIDER.STABILITY: {
      return new RequestParams()
    }
    default: {
      return new RequestParams()
    }
  }
}

function extractTextAndResponseReason (response, provider, modelName) {
  if (!response || response.error || response.body == null) return new Generation()

  const body = JSON.parse(Buffer.from(response.body).toString('utf8'))
  const shouldSetChoiceIds = provider.toUpperCase() === PROVIDER.COHERE && !modelName.includes('embed')
  try {
    switch (provider.toUpperCase()) {
      case PROVIDER.AI21: {
        if (modelName.includes('jamba')) {
          const generations = body.choices || []
          if (generations.length > 0) {
            const generation = generations[0]
            return new Generation({
              message: generation.message.content,
              finishReason: generation.finish_reason,
              choiceId: shouldSetChoiceIds ? generation.id : undefined,
              role: generation.message.role,
              inputTokens: body.usage?.prompt_tokens,
              outputTokens: body.usage?.completion_tokens,
            })
          }
        }
        const completions = body.completions || []
        if (completions.length > 0) {
          const completion = completions[0]
          return new Generation({
            message: completion.data?.text,
            finishReason: completion?.finishReason,
            choiceId: shouldSetChoiceIds ? completion?.id : undefined,
            inputTokens: body.usage?.prompt_tokens,
            outputTokens: body.usage?.completion_tokens,
          })
        }
        return new Generation()
      }
      case PROVIDER.AMAZON: {
        if (modelName.includes('embed')) {
          return new Generation({ message: body.embedding })
        }
        if (body.results) {
          const results = body.results || []
          if (results.length > 0) {
            const result = results[0]
            return new Generation({
              message: result.outputText,
              finishReason: result.completionReason,
              inputTokens: body.inputTextTokenCount,
              outputTokens: result.tokenCount,
            })
          }
        } else if (body.output) {
          const output = body.output || {}
          return new Generation({
            message: output.message?.content[0]?.text ?? 'Unsupported content type',
            finishReason: body.stopReason,
            role: output.message?.role,
            ...buildUsage(body.usage),
          })
        }
        break
      }
      case PROVIDER.ANTHROPIC: {
        if (Array.isArray(body.content)) {
          return new Generation({
            content: body.content,
            finishReason: body.stop_reason,
            role: 'assistant',
            ...buildUsage(body.usage),
          })
        }
        let message = body.completion
        if (body.content) {
          message = body.content
        }
        return new Generation({ message, finishReason: body.stop_reason })
      }
      case PROVIDER.COHERE: {
        if (modelName.includes('embed')) {
          const embeddings = body.embeddings || [[]]
          if (embeddings.length > 0) {
            return new Generation({ message: embeddings[0] })
          }
        }

        if (body.text) {
          return new Generation({
            message: body.text,
            finishReason: body.finish_reason,
            choiceId: shouldSetChoiceIds ? body.response_id : undefined,
          })
        }

        const generations = body.generations || []
        if (generations.length > 0) {
          const generation = generations[0]
          return new Generation({
            message: generation.text,
            finishReason: generation.finish_reason,
            choiceId: shouldSetChoiceIds ? generation.id : undefined,
            messages: generations.map(generation => ({
              content: generation.text,
              role: '',
            })),
          })
        }
        break
      }
      case PROVIDER.META: {
        return new Generation({
          message: body.generation,
          finishReason: body.stop_reason,
          inputTokens: body.prompt_token_count,
          outputTokens: body.generation_token_count,
        })
      }
      case PROVIDER.MISTRAL: {
        const mistralGenerations = body.outputs || []
        if (mistralGenerations.length > 0) {
          const generation = mistralGenerations[0]
          return new Generation({ message: generation.text, finishReason: generation.stop_reason })
        }
        break
      }
      case PROVIDER.STABILITY: {
        return new Generation()
      }
      default: {
        return new Generation()
      }
    }
  } catch {
    log.warn('Unable to extract text/finishReason from response body. Defaulting to empty text/finishReason.')
    return new Generation()
  }

  return new Generation()
}

/**
 * Convert a Converse content-block array to an LLMObs message array.
 *
 * @param {string} role
 * @param {Array<object>} contentBlocks
 * @returns {Array<{ content?: string, role: string, toolCalls?: Array, toolResults?: Array }>}
 */
function extractMessagesFromConverseContent (role, contentBlocks) {
  let content = ''
  const toolCalls = []
  const unsupportedMessages = []
  const toolResultMessages = []

  if (contentBlocks) {
    for (const block of contentBlocks) {
      if (block == null || typeof block !== 'object') continue
      if (typeof block.text === 'string') {
        content += content ? ` ${block.text}` : block.text
      } else if (typeof block.guardContent?.text?.text === 'string') {
        const text = block.guardContent.text.text
        content += content ? ` ${text}` : text
      } else if (block.toolUse) {
        toolCalls.push(buildToolCall(block.toolUse))
      } else if (block.toolResult) {
        if (block.toolResult.content) {
          for (const item of block.toolResult.content) {
            toolResultMessages.push({
              role: 'user',
              toolResults: [{
                name: block.toolResult.name ?? '',
                result: resolveToolResultItem(item),
                toolId: block.toolResult.toolUseId ?? '',
                type: 'toolResult',
              }],
            })
          }
        }
      } else {
        unsupportedMessages.push({
          content: `[Unsupported content type: ${getContentBlockType(block)}]`,
          role,
        })
      }
    }
  }

  const messages = []
  if (content || toolCalls.length > 0) {
    const message = { role }
    if (content) message.content = content
    if (toolCalls.length > 0) message.toolCalls = toolCalls
    messages.push(message)
  }
  messages.push(...unsupportedMessages, ...toolResultMessages)
  return messages
}

/**
 * Resolve a Converse `ContentBlock`'s member type. The block is a key-presence
 * tagged union (no `type` discriminator), so the active member is its sole own
 * key. For forward-compat `$unknown` members the real type is the first element
 * of the `[name, value]` tuple.
 *
 * @param {object} block
 * @returns {string}
 */
function getContentBlockType (block) {
  const key = Object.keys(block)[0]
  if (key === '$unknown') return block.$unknown?.[0] ?? 'unknown'
  return key ?? 'unknown'
}

// Always emit at least one output message so downstream tagging has a role to attach to.
function toOutputMessages (role, contentBlocks) {
  const messages = extractMessagesFromConverseContent(role, contentBlocks)
  return messages.length > 0 ? messages : [{ role, content: '' }]
}

function buildToolCall ({ name, input, toolUseId }) {
  return { name: name ?? '', arguments: input ?? {}, toolId: toolUseId ?? '', type: 'toolUse' }
}

function parseToolInput (inputStr) {
  try {
    return JSON.parse(inputStr)
  } catch {
    log.warn('Failed to parse Converse stream toolUse.input JSON; emitting empty arguments')
    return {}
  }
}

function resolveToolResultItem (item) {
  if (item == null || typeof item !== 'object') return '[Unsupported content type(s): unknown]'
  if (typeof item.text === 'string') return item.text
  if (item.json != null) return JSON.stringify(item.json)
  return `[Unsupported content type(s): ${getContentBlockType(item)}]`
}

function buildUsage (usage = {}) {
  return {
    inputTokens: usage.inputTokens ?? usage.input_tokens,
    outputTokens: usage.outputTokens ?? usage.output_tokens,
    cacheReadTokens: usage.cacheReadInputTokens ??
      usage.cacheReadInputTokenCount ??
      usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cacheWriteInputTokens ??
      usage.cacheWriteInputTokenCount ??
      usage.cache_creation_input_tokens,
  }
}

/**
 * Extract tool definitions from a Converse request's `toolConfig.tools`,
 * mapping Bedrock's `toolSpec` shape to LLMObs `ToolDefinition` shape.
 *
 * @param {object} params - Converse request params with optional `toolConfig.tools[].toolSpec`.
 * @returns {Array<{ name: string, description: string, schema: object }>}
 */
function extractConverseToolDefinitions (params) {
  const toolDefinitions = []
  const tools = params.toolConfig?.tools
  if (tools) {
    for (const tool of tools) {
      const toolSpec = tool?.toolSpec
      if (!toolSpec?.name) continue
      toolDefinitions.push({
        name: toolSpec.name,
        description: toolSpec.description ?? '',
        schema: toolSpec.inputSchema ?? {},
      })
    }
  }
  return toolDefinitions
}

/**
 * Extract request metadata + rendered input messages from a Converse /
 * ConverseStream request.
 *
 * @param {{ modelId?: string, messages?: Array, system?: Array, inferenceConfig?: object, toolConfig?: object }} params
 * @returns {RequestParams}
 */
function extractRequestParamsConverse (params) {
  const prompt = []
  if (params.system) {
    prompt.push(...extractMessagesFromConverseContent('system', params.system))
  }
  if (params.messages) {
    for (const msg of params.messages) {
      if (msg == null || typeof msg !== 'object') continue
      prompt.push(...extractMessagesFromConverseContent(msg.role || 'user', msg.content))
    }
  }

  const { temperature, topP, maxTokens, stopSequences } = params.inferenceConfig || {}
  return new RequestParams({ prompt, temperature, topP, maxTokens, stopSequences })
}

/**
 * Extract output messages + usage from a non-stream Converse response.
 *
 * @param {{ output?: { message?: { role?: string, content?: Array } }, stopReason?: string, usage?: object }} response
 * @returns {Generation}
 */
function extractTextAndResponseReasonConverse (response) {
  const outputMessage = response?.output?.message
  const role = outputMessage?.role || 'assistant'

  return new Generation({
    role,
    finishReason: response?.stopReason || '',
    ...buildUsage(response?.usage),
    messages: toOutputMessages(role, outputMessage?.content),
  })
}

/**
 * Aggregate Converse stream events into a single output message + usage.
 * One messageStart / messageStop pair per response, so one message out.
 *
 * Stream events describe the same content-block structure as the non-stream
 * response, spread across start/delta chunks. We reassemble those chunks
 * into a normalized content-block array and reuse the non-stream extractor.
 *
 * @param {Array<object> | undefined} chunks - Ordered ConverseStreamOutput events.
 * @returns {Generation}
 */
function extractTextAndResponseReasonConverseFromStream (chunks) {
  let role = 'assistant'
  let stopReason = ''
  let usage = {}
  const blocksByIdx = new Map()

  if (chunks) {
    for (const chunk of chunks) {
      if (chunk.messageStart?.role) {
        role = chunk.messageStart.role
      } else if (chunk.messageStop?.stopReason) {
        stopReason = chunk.messageStop.stopReason
      } else if (chunk.metadata?.usage) {
        usage = chunk.metadata.usage
      } else if (chunk.contentBlockStart?.start?.toolUse) {
        const { contentBlockIndex, start: { toolUse } } = chunk.contentBlockStart
        blocksByIdx.set(contentBlockIndex, {
          toolUse: { toolUseId: toolUse.toolUseId, name: toolUse.name, inputStr: '' },
        })
      } else if (chunk.contentBlockDelta) {
        const { contentBlockIndex, delta } = chunk.contentBlockDelta
        if (typeof delta?.text === 'string') {
          const block = blocksByIdx.get(contentBlockIndex) ?? {}
          block.text = (block.text ?? '') + delta.text
          blocksByIdx.set(contentBlockIndex, block)
        } else if (typeof delta?.toolUse?.input === 'string') {
          const block = blocksByIdx.get(contentBlockIndex) ?? { toolUse: { inputStr: '' } }
          block.toolUse ??= { inputStr: '' }
          block.toolUse.inputStr += delta.toolUse.input
          blocksByIdx.set(contentBlockIndex, block)
        }
      }
    }
  }

  const contentBlocks = [...blocksByIdx.keys()].sort((a, b) => a - b).map(i => {
    const block = blocksByIdx.get(i)
    if (block.toolUse) {
      const { toolUseId, name, inputStr } = block.toolUse
      block.toolUse = { toolUseId, name, input: parseToolInput(inputStr) }
    }
    return block
  })

  return new Generation({
    role,
    finishReason: stopReason,
    ...buildUsage(usage),
    messages: toOutputMessages(role, contentBlocks),
  })
}

module.exports = {
  Generation,
  RequestParams,
  extractTextAndResponseReasonFromStream,
  parseModelId,
  extractRequestParams,
  extractTextAndResponseReason,
  extractMessagesFromConverseContent,
  extractConverseToolDefinitions,
  extractRequestParamsConverse,
  extractTextAndResponseReasonConverse,
  extractTextAndResponseReasonConverseFromStream,
  PROVIDER,
}

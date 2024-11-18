'use strict'

const log = require('../../../log')
const LLMObsTagger = require('../../tagger')
const LLMObsPlugin = require('../base')

const pluginManager = require('../../../../../..')._pluginManager

const ANTHROPIC_PROVIDER_NAME = 'anthropic'
const BEDROCK_PROVIDER_NAME = 'amazon_bedrock'
const OPENAI_PROVIDER_NAME = 'openai'

const SUPPORTED_INTEGRATIONS = ['openai']
const LLM_SPAN_TYPES = ['llm', 'chat_model', 'embedding']
const LLM = 'llm'
const WORKFLOW = 'workflow'
const EMBEDDING = 'embedding'
const SUPPORTED_OPERATIONS = ['llm', 'chat_model', 'embedding', 'chain']

const ROLE_MAPPINGS = {
  human: 'user',
  ai: 'assistant',
  system: 'system'
}

class LangChainLLMObsPlugin extends LLMObsPlugin {
  static get prefix () {
    return 'tracing:apm:langchain:invoke'
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const tags = span?.context()._tags || {}

    const modelProvider = tags['langchain.request.provider'] // could be undefined
    const modelName = tags['langchain.request.model'] // could be undefined
    const kind = this.getKind(ctx.type, modelProvider)
    const name = tags['resource.name']

    return {
      modelProvider,
      modelName,
      kind,
      name
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const type = ctx.type // langchain operation type

    if (!SUPPORTED_OPERATIONS.includes(type)) {
      log.warn(`Unsupported LangChain operation type: ${type}`)
      return
    }

    const provider = span?.context()._tags['langchain.request.provider']
    const integrationName = this.getIntegrationName(type, provider)
    this._setMetadata(span, provider)

    const inputs = ctx.args?.[0]
    const results = ctx.result
    const options = ctx.args?.[1]

    switch (type) {
      case 'chain':
        this._setMetaTagsFromChain(span, inputs, results)
        break
      case 'chat_model':
        this._setMetaTagsFromChatModel(span, inputs, results, options, integrationName)
        break
      case 'llm':
        this._setMetaTagsFromLLM(span, inputs, results)
        break
      case 'embedding':
        this._setMetaTagsFromEmbedding(span, inputs, results)
        break
    }
  }

  _setMetadata (span, provider) {
    if (!provider) return

    const metadata = {}

    const temperature =
      span?.context()._tags[`langchain.request.${provider}.parameters.temperature`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.model_kwargs.temperature`]

    const maxTokens =
      span?.context()._tags[`langchain.request.${provider}.parameters.max_tokens`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.maxTokens`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.model_kwargs.max_tokens`]

    if (temperature) {
      metadata.temperature = parseFloat(temperature)
    }

    if (maxTokens) {
      metadata.maxTokens = parseInt(maxTokens)
    }

    this._tagger.tagMetadata(span, metadata)
  }

  _setMetaTagsFromChain (span, inputs, results) {
    let input, output
    if (inputs) {
      input = this.formatIO(inputs)
    }

    if (!results || this.spanHasError(span)) {
      output = ''
    } else {
      output = this.formatIO(results)
    }

    // chain spans will always be workflows
    this._tagger.tagTextIO(span, input, output)
  }

  _setMetaTagsFromChatModel (span, inputs, results, options, integration) {
    if (integration === 'openai' && options?.response_format) {
      // langchain-openai will call a beta client if "response_format" is passed in on the options object
      // we do not trace these calls, so this should be an llm span
      this._tagger.changeKind(span, LLM)
    }
    const spanKind = LLMObsTagger.getSpanKind(span)
    const isWorkflow = spanKind === 'workflow'

    const inputMessages = []
    if (!Array.isArray(inputs)) inputs = [inputs]

    for (const messageSet of inputs) {
      for (const message of messageSet) {
        const content = message.content || ''
        const role = this.getRole(message)
        inputMessages.push({ content, role })
      }
    }

    if (this.spanHasError(span)) {
      if (isWorkflow) {
        this._tagger.tagTextIO(span, inputMessages, [{ content: '' }])
      } else {
        this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      }
      return
    }

    const outputMessages = []
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0
    let tokensSetTopLevel = false
    const tokensPerRunId = {}

    if (!isWorkflow) {
      const tokens = this.checkTokenUsageChatOrLLMResult(results)
      inputTokens = tokens.inputTokens
      outputTokens = tokens.outputTokens
      totalTokens = tokens.totalTokens
      tokensSetTopLevel = totalTokens > 0
    }

    for (const messageSet of results.generations) {
      for (const chatCompletion of messageSet) {
        const chatCompletionMessage = chatCompletion.message
        const role = this.getRole(chatCompletionMessage)
        const content = chatCompletionMessage.text || ''
        const toolCalls = this.extractToolCalls(chatCompletionMessage)
        outputMessages.push({ content, role, toolCalls })

        if (!isWorkflow && !tokensSetTopLevel) {
          const { tokens, runId } = this.checkTokenUsageFromAIMessage(chatCompletionMessage)
          if (!tokensPerRunId[runId]) {
            tokensPerRunId[runId] = tokens
          } else {
            tokensPerRunId[runId].inputTokens += tokens.inputTokens
            tokensPerRunId[runId].outputTokens += tokens.outputTokens
            tokensPerRunId[runId].totalTokens += tokens.totalTokens
          }
        }
      }
    }

    if (!isWorkflow && !tokensSetTopLevel) {
      inputTokens = Object.values(tokensPerRunId).reduce((acc, val) => acc + val.inputTokens, 0)
      outputTokens = Object.values(tokensPerRunId).reduce((acc, val) => acc + val.outputTokens, 0)
      totalTokens = Object.values(tokensPerRunId).reduce((acc, val) => acc + val.totalTokens, 0)
    }

    if (isWorkflow) {
      this._tagger.tagTextIO(span, inputMessages, outputMessages)
    } else {
      this._tagger.tagLLMIO(span, inputMessages, outputMessages)
      this._tagger.tagMetrics(span, {
        inputTokens,
        outputTokens,
        totalTokens
      })
    }
  }

  _setMetaTagsFromLLM (span, inputs, results) {
    const isWorkflow = LLMObsTagger.getSpanKind(span) === 'workflow'
    const prompts = Array.isArray(inputs) ? inputs : [inputs]

    let outputs
    if (this.spanHasError(span)) {
      outputs = [{ content: '' }]
    } else {
      outputs = results.generations.map(completion => ({ content: completion[0].text }))

      if (!isWorkflow) {
        const tokens = this.checkTokenUsageChatOrLLMResult(results)
        this._tagger.tagMetrics(span, tokens)
      }
    }

    if (isWorkflow) {
      this._tagger.tagTextIO(span, prompts, outputs)
    } else {
      this._tagger.tagLLMIO(span, prompts, outputs)
    }
  }

  _setMetaTagsFromEmbedding (span, inputs, results) {
    const isWorkflow = LLMObsTagger.getSpanKind(span) === 'workflow'
    let embeddingInput, embeddingOutput

    if (isWorkflow) {
      embeddingInput = this.formatIO(inputs)
    } else {
      const input = Array.isArray(inputs) ? inputs : [inputs]
      embeddingInput = input.map(doc => ({ text: doc }))
    }

    if (this.spanHasError(span) || !results) {
      embeddingOutput = ''
    } else {
      let embeddingDimensions, embeddingsCount
      if (typeof results[0] === 'number') {
        embeddingsCount = 1
        embeddingDimensions = results.length
      } else {
        embeddingsCount = results.length
        embeddingDimensions = results[0].length
      }

      embeddingOutput = `[${embeddingsCount} embedding(s) returned with size ${embeddingDimensions}]`
    }

    if (isWorkflow) {
      this._tagger.tagTextIO(span, embeddingInput, embeddingOutput)
    } else {
      this._tagger.tagEmbeddingIO(span, embeddingInput, embeddingOutput)
    }
  }

  checkTokenUsageChatOrLLMResult (results) {
    const llmOutput = results.llmOutput
    const tokens = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
    if (!llmOutput) return tokens
    const tokenUsage = llmOutput.tokenUsage || llmOutput.usageMetadata || llmOutput.usage || {}
    if (!tokenUsage) return tokens

    tokens.inputTokens = tokenUsage.promptTokens || tokenUsage.inputTokens || 0
    tokens.outputTokens = tokenUsage.completionTokens || tokenUsage.outputTokens || 0
    tokens.totalTokens = tokenUsage.totalTokens || tokens.inputTokens + tokens.outputTokens

    return tokens
  }

  checkTokenUsageFromAIMessage (message) {
    let usage = message.usage_metadata
    const runId = message.run_id || message.id || ''
    const runIdBase = runId ? runId.split('-').slice(0, -1).join('-') : ''

    const responseMetadata = message.response_metadata || {}
    usage = usage || responseMetadata.usage || responseMetadata.tokenUsage || {}

    const inputTokens = usage.promptTokens || usage.inputTokens || usage.prompt_tokens || usage.input_tokens || 0
    const outputTokens =
      usage.completionTokens || usage.outputTokens || usage.completion_tokens || usage.output_tokens || 0
    const totalTokens = usage.totalTokens || inputTokens + outputTokens

    return {
      tokens: {
        inputTokens,
        outputTokens,
        totalTokens
      },
      runId: runIdBase
    }
  }

  extractToolCalls (message) {
    let toolCalls = message.tool_calls
    if (!toolCalls) return []

    const toolCallsInfo = []
    if (!Array.isArray(toolCalls)) toolCalls = [toolCalls]
    for (const toolCall of toolCalls) {
      toolCallsInfo.push({
        name: toolCall.name || '',
        arguments: toolCall.args || {},
        tool_id: toolCall.id || ''
      })
    }

    return toolCallsInfo
  }

  formatIO (messages) {
    if (messages.constructor.name === 'Object') { // plain JSON
      const formatted = {}
      for (const [key, value] of Object.entries(messages)) {
        formatted[key] = this.formatIO(value)
      }
    } else if (Array.isArray(messages)) {
      return messages.map(message => this.formatIO(message))
    } else { // either a BaseMesage type or a string
      return this.getContentFromMessage(messages)
    }
  }

  getContentFromMessage (message) {
    if (typeof message === 'string') {
      return message
    } else {
      try {
        const messageContent = {}
        messageContent.content = message.content || ''

        const role = this.getRole(message)
        if (role) messageContent.role = role

        return messageContent
      } catch {
        return JSON.stringify(message)
      }
    }
  }

  getKind (type, provider) {
    if (LLM_SPAN_TYPES.includes(type)) {
      const llmobsIntegration = this.getIntegrationName(type, provider)

      if (!this.isLLMIntegrationEnabled(llmobsIntegration)) {
        return type === 'embedding' ? EMBEDDING : LLM
      }
    }

    return WORKFLOW
  }

  getIntegrationName (type, provider = 'custom') {
    if (provider.startsWith(BEDROCK_PROVIDER_NAME)) {
      return 'bedrock'
    } else if (provider.startsWith(OPENAI_PROVIDER_NAME)) {
      return 'openai'
    } else if (type === 'chat_model' && provider.startsWith(ANTHROPIC_PROVIDER_NAME)) {
      return 'anthropic'
    }

    return provider
  }

  isLLMIntegrationEnabled (integration) {
    return SUPPORTED_INTEGRATIONS.includes(integration) && pluginManager?._pluginsByName[integration]?.llmobs?._enabled
  }

  getRole (message) {
    if (message.role) return ROLE_MAPPINGS[message.role] || message.role

    const type = (
      (typeof message.getType === 'function' && message.getType()) ||
      (typeof message._getType === 'function' && message._getType())
    )

    return ROLE_MAPPINGS[type] || type
  }
}

module.exports = LangChainLLMObsPlugin

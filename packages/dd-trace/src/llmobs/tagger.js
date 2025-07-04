'use strict'

const log = require('../log')
const {
  MODEL_NAME,
  MODEL_PROVIDER,
  SESSION_ID,
  ML_APP,
  SPAN_KIND,
  INPUT_VALUE,
  OUTPUT_DOCUMENTS,
  INPUT_DOCUMENTS,
  OUTPUT_VALUE,
  METADATA,
  METRICS,
  PARENT_ID_KEY,
  INPUT_MESSAGES,
  OUTPUT_MESSAGES,
  TAGS,
  NAME,
  PROPAGATED_PARENT_ID_KEY,
  ROOT_PARENT_ID,
  INPUT_TOKENS_METRIC_KEY,
  OUTPUT_TOKENS_METRIC_KEY,
  TOTAL_TOKENS_METRIC_KEY,
  INTEGRATION,
  DECORATOR,
  PROPAGATED_ML_APP_KEY
} = require('./constants/tags')

// global registry of LLMObs spans
// maps LLMObs spans to their annotations
const registry = new WeakMap()

class LLMObsTagger {
  constructor (config, softFail = false) {
    this._config = config

    this.softFail = softFail
  }

  static get tagMap () {
    return registry
  }

  static getSpanKind (span) {
    return registry.get(span)?.[SPAN_KIND]
  }

  registerLLMObsSpan (span, {
    modelName,
    modelProvider,
    sessionId,
    mlApp,
    parent,
    kind,
    name,
    integration,
    _decorator
  } = {}) {
    if (!this._config.llmobs.enabled) return
    if (!kind) return // do not register it in the map if it doesn't have an llmobs span kind

    const spanMlApp =
      mlApp ||
      registry.get(parent)?.[ML_APP] ||
      span.context()._trace.tags[PROPAGATED_ML_APP_KEY] ||
      this._config.llmobs.mlApp

    if (!spanMlApp) {
      throw new Error(
        '[LLMObs] Cannot start an LLMObs span without an mlApp configured.' +
        'Ensure this configuration is set before running your application.'
      )
    }

    this._register(span)

    this._setTag(span, ML_APP, spanMlApp)

    if (name) this._setTag(span, NAME, name)

    this._setTag(span, SPAN_KIND, kind)
    if (modelName) this._setTag(span, MODEL_NAME, modelName)
    if (modelProvider) this._setTag(span, MODEL_PROVIDER, modelProvider)

    sessionId = sessionId || registry.get(parent)?.[SESSION_ID]
    if (sessionId) this._setTag(span, SESSION_ID, sessionId)
    if (integration) this._setTag(span, INTEGRATION, integration)
    if (_decorator) this._setTag(span, DECORATOR, _decorator)

    const parentId =
      parent?.context().toSpanId() ??
      span.context()._trace.tags[PROPAGATED_PARENT_ID_KEY] ??
      ROOT_PARENT_ID
    this._setTag(span, PARENT_ID_KEY, parentId)
  }

  // TODO: similarly for the following `tag` methods,
  // how can we transition from a span weakmap to core API functionality
  tagLLMIO (span, inputData, outputData) {
    this.#tagMessages(span, inputData, INPUT_MESSAGES)
    this.#tagMessages(span, outputData, OUTPUT_MESSAGES)
  }

  tagEmbeddingIO (span, inputData, outputData) {
    this.#tagDocuments(span, inputData, INPUT_DOCUMENTS)
    this.#tagText(span, outputData, OUTPUT_VALUE)
  }

  tagRetrievalIO (span, inputData, outputData) {
    this.#tagText(span, inputData, INPUT_VALUE)
    this.#tagDocuments(span, outputData, OUTPUT_DOCUMENTS)
  }

  tagTextIO (span, inputData, outputData) {
    this.#tagText(span, inputData, INPUT_VALUE)
    this.#tagText(span, outputData, OUTPUT_VALUE)
  }

  tagMetadata (span, metadata) {
    const existingMetadata = registry.get(span)?.[METADATA]
    if (existingMetadata) {
      Object.assign(existingMetadata, metadata)
    } else {
      this._setTag(span, METADATA, metadata)
    }
  }

  tagMetrics (span, metrics) {
    const filterdMetrics = {}
    for (const [key, value] of Object.entries(metrics)) {
      let processedKey = key

      // processing these specifically for our metrics ingestion
      switch (key) {
        case 'inputTokens':
          processedKey = INPUT_TOKENS_METRIC_KEY
          break
        case 'outputTokens':
          processedKey = OUTPUT_TOKENS_METRIC_KEY
          break
        case 'totalTokens':
          processedKey = TOTAL_TOKENS_METRIC_KEY
          break
      }

      if (typeof value === 'number') {
        filterdMetrics[processedKey] = value
      } else {
        this.#handleFailure(`Value for metric '${key}' must be a number, instead got ${value}`, 'invalid_metrics')
      }
    }

    const existingMetrics = registry.get(span)?.[METRICS]
    if (existingMetrics) {
      Object.assign(existingMetrics, filterdMetrics)
    } else {
      this._setTag(span, METRICS, filterdMetrics)
    }
  }

  tagSpanTags (span, tags) {
    const currentTags = registry.get(span)?.[TAGS]
    if (currentTags) {
      Object.assign(currentTags, tags)
    } else {
      this._setTag(span, TAGS, tags)
    }
  }

  changeKind (span, newKind) {
    this._setTag(span, SPAN_KIND, newKind)
  }

  #tagText (span, data, key) {
    if (data) {
      if (typeof data === 'string') {
        this._setTag(span, key, data)
      } else {
        try {
          this._setTag(span, key, JSON.stringify(data))
        } catch {
          const type = key === INPUT_VALUE ? 'input' : 'output'
          this.#handleFailure(`Failed to parse ${type} value, must be JSON serializable.`, 'invalid_io_text')
        }
      }
    }
  }

  #tagDocuments (span, data, key) {
    if (!data) {
      return
    }

    if (!Array.isArray(data)) {
      data = [data]
    }

    const documents = []
    for (const document of data) {
      if (typeof document === 'string') {
        documents.push({ text: document })
        continue
      }

      if (document == null || typeof document !== 'object') {
        this.#handleFailure('Documents must be a string, object, or list of objects.', 'invalid_embedding_io')
        continue
      }

      const { text, name, id, score } = document

      const valid = typeof text === 'string'
      if (!valid) {
        this.#handleFailure('Document text must be a string.', 'invalid_embedding_io')
      }

      const documentObj = { text }

      const condition1 = this.#tagConditionalString(name, 'Document name', documentObj, 'name')
      const condition2 = this.#tagConditionalString(id, 'Document ID', documentObj, 'id')
      const condition3 = this.#tagConditionalNumber(score, 'Document score', documentObj, 'score')

      if (valid && condition1 && condition2 && condition3) {
        documents.push(documentObj)
      }
    }

    if (documents.length) {
      this._setTag(span, key, documents)
    }
  }

  #filterToolCalls (toolCalls) {
    if (!Array.isArray(toolCalls)) {
      toolCalls = [toolCalls]
    }

    const filteredToolCalls = []
    for (const toolCall of toolCalls) {
      if (typeof toolCall !== 'object') {
        this.#handleFailure('Tool call must be an object.', 'invalid_io_messages')
        continue
      }

      const { name, arguments: args, toolId, type } = toolCall
      const toolCallObj = {}

      const condition1 = this.#tagConditionalString(name, 'Tool name', toolCallObj, 'name')
      const condition2 = this.#tagConditionalObject(args, 'Tool arguments', toolCallObj, 'arguments')
      const condition3 = this.#tagConditionalString(toolId, 'Tool ID', toolCallObj, 'tool_id')
      const condition4 = this.#tagConditionalString(type, 'Tool type', toolCallObj, 'type')

      if (condition1 && condition2 && condition3 && condition4) {
        filteredToolCalls.push(toolCallObj)
      }
    }
    return filteredToolCalls
  }

  #tagMessages (span, data, key) {
    if (!data) {
      return
    }
    if (!Array.isArray(data)) {
      data = [data]
    }

    const messages = []

    for (const message of data) {
      if (typeof message === 'string') {
        messages.push({ content: message })
        continue
      }
      if (message == null || typeof message !== 'object') {
        this.#handleFailure('Messages must be a string, object, or list of objects', 'invalid_io_messages')
        continue
      }

      const { content = '', role } = message
      const toolCalls = message.toolCalls
      const toolId = message.toolId
      const messageObj = { content }

      const valid = typeof content === 'string'
      if (!valid) {
        this.#handleFailure('Message content must be a string.', 'invalid_io_messages')
      }

      let condition = this.#tagConditionalString(role, 'Message role', messageObj, 'role')

      if (toolCalls) {
        const filteredToolCalls = this.#filterToolCalls(toolCalls)

        if (filteredToolCalls.length) {
          messageObj.tool_calls = filteredToolCalls
        }
      }

      if (toolId) {
        if (role === 'tool') {
          condition = this.#tagConditionalString(toolId, 'Tool ID', messageObj, 'tool_id')
        } else {
          log.warn(`Tool ID for tool message not associated with a "tool" role, instead got "${role}"`)
        }
      }

      if (valid && condition) {
        messages.push(messageObj)
      }
    }

    if (messages.length) {
      this._setTag(span, key, messages)
    }
  }

  #tagConditionalString (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'string') {
      this.#handleFailure(`"${type}" must be a string.`)
      return false
    }
    carrier[key] = data
    return true
  }

  #tagConditionalNumber (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'number') {
      this.#handleFailure(`"${type}" must be a number.`)
      return false
    }
    carrier[key] = data
    return true
  }

  #tagConditionalObject (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'object') {
      this.#handleFailure(`"${type}" must be an object.`)
      return false
    }
    carrier[key] = data
    return true
  }

  // any public-facing LLMObs APIs using this tagger should not soft fail
  // auto-instrumentation should soft fail
  #handleFailure (msg, errorTag) {
    if (this.softFail) {
      log.warn(msg)
    } else {
      const err = new Error(msg)
      if (errorTag) {
        Object.defineProperty(err, 'ddErrorTag', { get () { return errorTag } })
      }
      throw err
    }
  }

  _register (span) {
    if (!this._config.llmobs.enabled) return
    if (registry.has(span)) {
      this.#handleFailure(`LLMObs Span "${span._name}" already registered.`)
      return
    }

    registry.set(span, {})
  }

  _setTag (span, key, value) {
    if (!this._config.llmobs.enabled) return
    if (!registry.has(span)) {
      this.#handleFailure(`Span "${span._name}" must be an LLMObs generated span.`)
      return
    }

    const tagsCarrier = registry.get(span)
    tagsCarrier[key] = value
  }
}

module.exports = LLMObsTagger

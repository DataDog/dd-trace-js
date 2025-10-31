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
  CACHE_READ_INPUT_TOKENS_METRIC_KEY,
  CACHE_WRITE_INPUT_TOKENS_METRIC_KEY,
  INPUT_TOKENS_METRIC_KEY,
  OUTPUT_TOKENS_METRIC_KEY,
  TOTAL_TOKENS_METRIC_KEY,
  INTEGRATION,
  DECORATOR,
  PROPAGATED_ML_APP_KEY
} = require('./constants/tags')
const { storage } = require('./storage')

/** @typedef {import('../opentracing/span')} Span */

/**
 * @typedef {{
 *  modelName?: string
 *  modelProvider?: string
 *  sessionId?: string
 *  mlApp?: string
 *  parent?: Span
 *  kind: 'llm' | 'agent' | 'workflow' | 'task' | 'tool' | 'embedding' | 'retrieval'
 *  name?: string
 *  integration?: string
 *  decorator?: boolean
 * }} LLMObsSpanRegisterOptions
 */

/**
 * @typedef {{
 *  content?: string
 *  role?: string
 *  toolCalls?: ToolCall[]
 *  toolResults?: ToolResult[]
 *  toolId?: string
 * }} Message
 */

/**
 * @typedef {{
 *  name?: string,
 *  arguments?: string | object,
 *  toolId?: string,
 *  type?: string
 * }} ToolCall
 */

/**
 * @typedef {{
 *  result?: string
 *  toolId?: string
 *  type?: string
 * }} ToolResult
 */

/**
 * @typedef {{
 *  text?: string
 *  name?: string
 *  id?: string
 *  score?: number
 * }} Document
 */

class LLMObsTagger {
  /**
   * Global registry mapping Span objects to their LLMObs annotations
   * @type {WeakMap<Span, Record<string, any>>}
   */
  static tagMap = new WeakMap()

  /** @type {import('../config')} */
  #config

  /** @type {boolean} */
  #softFail

  constructor (config, softFail = false) {
    this.#config = config
    this.#softFail = softFail
  }

  /**
   * Gets the LLMObs span kind for the given span
   * @param {Span} span
   * @returns {string | undefined}
   */
  static getSpanKind (span) {
    return LLMObsTagger.tagMap.get(span)?.[SPAN_KIND]
  }

  /**
   * Registers a Datadog Span as an LLMObs span, registering it in the global registry and
   * validating its associated starting annotations.
   * @param {Span} span
   * @param {LLMObsSpanRegisterOptions} options Options for registering the LLMObs span.
   * @returns {void}
   */
  registerLLMObsSpan (span, {
    modelName,
    modelProvider,
    sessionId,
    mlApp,
    parent,
    kind,
    name,
    integration,
    decorator
  } = {}) {
    if (!this.#config.llmobs.enabled) return
    if (!kind) return // do not register it in the map if it doesn't have an llmobs span kind

    const spanMlApp =
      mlApp ||
      LLMObsTagger.tagMap.get(parent)?.[ML_APP] ||
      span.context()._trace.tags[PROPAGATED_ML_APP_KEY] ||
      this.#config.llmobs.mlApp ||
      this.#config.service // this should always have a default

    if (!spanMlApp) {
      throw new Error(
        '[LLMObs] Cannot start an LLMObs span without an mlApp configured.' +
        'Ensure this configuration is set before running your application.'
      )
    }

    this.#register(span)

    this.#setAnnotation(span, ML_APP, spanMlApp)

    if (name) this.#setAnnotation(span, NAME, name)

    this.#setAnnotation(span, SPAN_KIND, kind)
    if (modelName) this.#setAnnotation(span, MODEL_NAME, modelName)
    if (modelProvider) this.#setAnnotation(span, MODEL_PROVIDER, modelProvider)

    sessionId = sessionId || LLMObsTagger.tagMap.get(parent)?.[SESSION_ID]
    if (sessionId) this.#setAnnotation(span, SESSION_ID, sessionId)
    if (integration) this.#setAnnotation(span, INTEGRATION, integration)
    if (decorator) this.#setAnnotation(span, DECORATOR, decorator)

    const parentId =
      parent?.context().toSpanId() ??
      span.context()._trace.tags[PROPAGATED_PARENT_ID_KEY] ??
      ROOT_PARENT_ID
    this.#setAnnotation(span, PARENT_ID_KEY, parentId)

    // apply annotation context
    const annotationContext = storage.getStore()?.annotationContext

    // apply annotation context tags
    const tags = annotationContext?.tags
    if (tags) this.tagSpanTags(span, tags)

    // apply annotation context name
    const annotationContextName = annotationContext?.name
    if (annotationContextName) this.#setAnnotation(span, NAME, annotationContextName)
  }

  /**
   * Annotates the input and output messages for an LLM span.
   * @param {Span} span
   * @param {(string | Message | Message[])?} inputData
   * @param {(string | Message | Message[])?} outputData
   * @returns {void}
   */
  tagLLMIO (span, inputData, outputData) {
    this.#annotateMessages(span, inputData, INPUT_MESSAGES)
    this.#annotateMessages(span, outputData, OUTPUT_MESSAGES)
  }

  /**
   * Annotates the input and output documents for an embedding span.
   * @param {Span} span
   * @param {(string | Document | Document[])?} inputData
   * @param {string?} outputData
   * @returns {void}
   */
  tagEmbeddingIO (span, inputData, outputData) {
    this.#annotateDocuments(span, inputData, INPUT_DOCUMENTS)
    this.#annotateText(span, outputData, OUTPUT_VALUE)
  }

  /**
   * Annotates the input and output text for a retrieval span.
   * @param {Span} span
   * @param {string?} inputData
   * @param {(string | Document | Document[])?} outputData
   * @returns {void}
   */
  tagRetrievalIO (span, inputData, outputData) {
    this.#annotateText(span, inputData, INPUT_VALUE)
    this.#annotateDocuments(span, outputData, OUTPUT_DOCUMENTS)
  }

  /**
   * Annotates the input and output text for a text span.
   * @param {*} span
   * @param {string?} inputData
   * @param {string?} outputData
   * @returns {void}
   */
  tagTextIO (span, inputData, outputData) {
    this.#annotateText(span, inputData, INPUT_VALUE)
    this.#annotateText(span, outputData, OUTPUT_VALUE)
  }

  /**
   * Annotates the metadata for a span.
   * @param {Span} span
   * @param {Record<string, any>} metadata
   * @returns {void}
   */
  tagMetadata (span, metadata) {
    const existingMetadata = LLMObsTagger.tagMap.get(span)?.[METADATA]
    if (existingMetadata) {
      Object.assign(existingMetadata, metadata)
    } else {
      this.#setAnnotation(span, METADATA, metadata)
    }
  }

  /**
   * Annotates the metrics for a span.
   * @param {Span} span
   * @param {{
   *  inputTokens?: number,
   *  outputTokens?: number,
   *  totalTokens?: number,
   *  cacheReadTokens?: number,
   *  cacheWriteTokens?: number,
   * } & Record<string, number>} metrics
   * @returns {void}
   */
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
        case 'cacheReadTokens':
          processedKey = CACHE_READ_INPUT_TOKENS_METRIC_KEY
          break
        case 'cacheWriteTokens':
          processedKey = CACHE_WRITE_INPUT_TOKENS_METRIC_KEY
          break
      }

      if (typeof value === 'number') {
        filterdMetrics[processedKey] = value
      } else {
        this.#handleFailure(`Value for metric '${key}' must be a number, instead got ${value}`, 'invalid_metrics')
      }
    }

    const existingMetrics = LLMObsTagger.tagMap.get(span)?.[METRICS]
    if (existingMetrics) {
      Object.assign(existingMetrics, filterdMetrics)
    } else {
      this.#setAnnotation(span, METRICS, filterdMetrics)
    }
  }

  /**
   * Annotates the tags for a span.
   * @param {Span} span
   * @param {Record<string, any>} tags
   * @returns {void}
   */
  tagSpanTags (span, tags) {
    const currentTags = LLMObsTagger.tagMap.get(span)?.[TAGS]
    if (currentTags) {
      Object.assign(currentTags, tags)
    } else {
      this.#setAnnotation(span, TAGS, tags)
    }
  }

  /**
   * Changes the span kind.
   * @param {Span} span
   * @param {'llm' | 'agent' | 'workflow' | 'task' | 'tool' | 'embedding' | 'retrieval'} newKind
   * @returns {void}
   */
  changeKind (span, newKind) {
    this.#setAnnotation(span, SPAN_KIND, newKind)
  }

  /**
   * Annotates the text for the span for either input or output
   * @param {Span} span
   * @param {(string | object)?} data
   * @param {typeof INPUT_VALUE | typeof OUTPUT_VALUE} key
   */
  #annotateText (span, data, key) {
    if (data) {
      if (typeof data === 'string') {
        this.#setAnnotation(span, key, data)
      } else {
        try {
          this.#setAnnotation(span, key, JSON.stringify(data))
        } catch {
          const type = key === INPUT_VALUE ? 'input' : 'output'
          this.#handleFailure(`Failed to parse ${type} value, must be JSON serializable.`, 'invalid_io_text')
        }
      }
    }
  }

  /**
   * Annotates the documents for the span for either input or output
   * @param {Span} span
   * @param {(string | Document | Document[])?} data
   * @param {typeof INPUT_DOCUMENTS | typeof OUTPUT_DOCUMENTS} key
   * @returns {void}
   */
  #annotateDocuments (span, data, key) {
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
      this.#setAnnotation(span, key, documents)
    }
  }

  /**
   * Filters the tool calls to a list of valid tool calls
   * @param {ToolCall | ToolCall[]} toolCalls
   * @returns {ToolCall[]}
   */
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

  /**
   * Filters the tool results to a list of valid tool results
   * @param {ToolResult | ToolResult[]} toolResults
   * @returns {ToolResult[]}
   */
  #filterToolResults (toolResults) {
    if (!Array.isArray(toolResults)) {
      toolResults = [toolResults]
    }

    const filteredToolResults = []
    for (const toolResult of toolResults) {
      if (typeof toolResult !== 'object') {
        this.#handleFailure('Tool result must be an object.', 'invalid_io_messages')
        continue
      }

      const { result, toolId, type } = toolResult
      const toolResultObj = {}

      const condition1 = this.#tagConditionalString(result, 'Tool result', toolResultObj, 'result')
      const condition2 = this.#tagConditionalString(toolId, 'Tool ID', toolResultObj, 'tool_id')
      const condition3 = this.#tagConditionalString(type, 'Tool type', toolResultObj, 'type')

      if (condition1 && condition2 && condition3) {
        filteredToolResults.push(toolResultObj)
      }
    }
    return filteredToolResults
  }

  /**
   * Annotates the messages for the span for either input or output
   * @param {Span} span
   * @param {(string | Message | Message[])?} data
   * @param {typeof INPUT_MESSAGES | typeof OUTPUT_MESSAGES} key
   * @returns {void}
   */
  #annotateMessages (span, data, key) {
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
      const toolResults = message.toolResults
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

      if (toolResults) {
        const filteredToolResults = this.#filterToolResults(toolResults)

        if (filteredToolResults.length) {
          messageObj.tool_results = filteredToolResults
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
      this.#setAnnotation(span, key, messages)
    }
  }

  /**
   * Conditionally sets a string value on a carrier object
   * @param {*} data
   * @param {string} type description of the data to be logged in case of failure
   * @param {Record<string, any>} carrier
   * @param {string} key
   * @returns {boolean}
   */
  #tagConditionalString (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'string') {
      this.#handleFailure(`"${type}" must be a string.`)
      return false
    }
    carrier[key] = data
    return true
  }

  /**
 * Conditionally sets a number value on a carrier object
 * @param {*} data
 * @param {string} type description of the data to be logged in case of failure
 * @param {Record<string, any>} carrier
 * @param {string} key
 * @returns {boolean}
 */
  #tagConditionalNumber (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'number') {
      this.#handleFailure(`"${type}" must be a number.`)
      return false
    }
    carrier[key] = data
    return true
  }

  /**
   * Conditionally sets an object value on a carrier object
   * @param {*} data
   * @param {string} type description of the data to be logged in case of failure
   * @param {Record<string, any>} carrier
   * @param {string} key
   * @returns {boolean}
   */
  #tagConditionalObject (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'object') {
      this.#handleFailure(`"${type}" must be an object.`)
      return false
    }
    carrier[key] = data
    return true
  }

  /**
   * Handles a failure by logging a warning or throwing an error, depending on the softFail flag.
   * Any public-facing LLMObs APIs using this tagger should not soft fail.
   * Auto-instrumentation should soft fail.
   * @param {string} msg message to log in case of failure
   * @param {string?} errorTag error tag to add to the error
   * @returns {void}
   */
  #handleFailure (msg, errorTag) {
    if (this.#softFail) {
      log.warn(msg)
    } else {
      const err = new Error(msg)
      if (errorTag) {
        Object.defineProperty(err, 'ddErrorTag', { get () { return errorTag } })
      }
      throw err
    }
  }

  /**
   * Registers a span in the global registry, failing if the span is already registered.
   * @param {Span} span
   * @returns {void}
   */
  #register (span) {
    if (!this.#config.llmobs.enabled) return
    if (LLMObsTagger.tagMap.has(span)) {
      this.#handleFailure(`LLMObs Span "${span._name}" already registered.`)
      return
    }

    LLMObsTagger.tagMap.set(span, {})
  }

  /**
   * Annotates a span for a specific annotation entry, such as
   * METADATA, METRICS, TAGS, INPUT_MESSAGES, OUTPUT_MESSAGES, etc.
   * @param {Span} span
   * @param {string} key
   * @param {*} value
   * @returns {void}
   */
  #setAnnotation (span, key, value) {
    if (!this.#config.llmobs.enabled) return
    if (!LLMObsTagger.tagMap.has(span)) {
      this.#handleFailure(`Span "${span._name}" must be an LLMObs generated span.`)
      return
    }

    const tagsCarrier = LLMObsTagger.tagMap.get(span)
    tagsCarrier[key] = value
  }
}

module.exports = LLMObsTagger

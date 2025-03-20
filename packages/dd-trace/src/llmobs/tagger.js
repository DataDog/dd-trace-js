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
  TOTAL_TOKENS_METRIC_KEY
} = require('./constants/tags')

/** @typedef {import('../opentracing/span')} Span */

/**
 * global registry of LLMObs spans
 * maps LLMObs spans to their annotations
 * @type {WeakMap<Span, Record<string, any>>}
 */
const registry = new WeakMap()

/**
 * @typedef {{
 *   content: string,
 *   role?: string,
 *   toolCalls?: {
 *     name: string,
 *     arguments: { [key: string]: any },
 *     toolId: string,
 *     type: string
 *   }[]
 * }} Message
 */

/**
 * @typedef {{
 *  text: string,
 *  name?: string,
 *  id?: string,
 *  score?: number
 * }} Document
 */

class LLMObsTagger {
  constructor (config, softFail = false) {
    this._config = config

    this.softFail = softFail
  }

  static get tagMap () {
    return registry
  }

  /**
   * Get the LLMObs span kind associated with an APM span
   * @param {Span} span - span to get the llmobs span kind from
   * @returns {string} - the llmobs span kind
   */
  static getSpanKind (span) {
    return registry.get(span)?.[SPAN_KIND]
  }

  /**
   * Registers an APM span to our mapping of spans to LLMObs attributes.
   * This marks an APM span as an LLMObs span.
   * @param {Span} span
   * @param {Object} options - the set of attributes associated with the LLMObs span on register
   * @param {string} [options.modelName] - the model name associated with the span
   * @param {string} [options.modelProvider] - the model provider associated with the span
   * @param {string} [options.sessionId] - the session ID associated with the span
   * @param {string} [options.mlApp] - the mlApp associated with the span (overrides global mlApp)
   * @param {Span} [options.parent] - the parent span
   * @param {'llm' | 'retrieval' | 'embedding' | 'agent' | 'workflow' | 'tool' | 'task'} options.kind
   * - the llmobs span kind
   * @param {string} [options.name] - optional name to override the default (span) name
   * @returns {void}
   */
  registerLLMObsSpan (span, {
    modelName,
    modelProvider,
    sessionId,
    mlApp,
    parent,
    kind,
    name
  } = {}) {
    if (!this._config.llmobs.enabled) return
    if (!kind) return // do not register it in the map if it doesn't have an llmobs span kind

    this._register(span)

    if (name) this._setTag(span, NAME, name)

    this._setTag(span, SPAN_KIND, kind)
    if (modelName) this._setTag(span, MODEL_NAME, modelName)
    if (modelProvider) this._setTag(span, MODEL_PROVIDER, modelProvider)

    sessionId = sessionId || registry.get(parent)?.[SESSION_ID]
    if (sessionId) this._setTag(span, SESSION_ID, sessionId)

    if (!mlApp) mlApp = registry.get(parent)?.[ML_APP] || this._config.llmobs.mlApp
    this._setTag(span, ML_APP, mlApp)

    const parentId =
      parent?.context().toSpanId() ||
      span.context()._trace.tags[PROPAGATED_PARENT_ID_KEY] ||
      ROOT_PARENT_ID
    this._setTag(span, PARENT_ID_KEY, parentId)
  }

  /**
   * Associates input and output messages with the current span
   * @param {Span} span APM span
   * @param { string | string[] | Message | Message[] } [inputData] - the input messages
   * @param { string | string[] | Message | Message[]} [outputData] - the output messages
   */
  tagLLMIO (span, inputData, outputData) {
    this._tagMessages(span, inputData, INPUT_MESSAGES)
    this._tagMessages(span, outputData, OUTPUT_MESSAGES)
  }

  /**
   * Associates input documents and output values with the current span
   * @param {Span} span APM span
   * @param {string | string[] | Document | Document[]} [inputData] input documents
   * @param {string | Record<string, any>} [outputData] output value
   */
  tagEmbeddingIO (span, inputData, outputData) {
    this._tagDocuments(span, inputData, INPUT_DOCUMENTS)
    this._tagText(span, outputData, OUTPUT_VALUE)
  }

  /**
   * Associates input value and output documents with the current span
   * @param {Span} span APM span
   * @param {string | Record<string, any>} [inputData] input value
   * @param {string | string[] | Document | Document[]} [outputData] output documents
   */
  tagRetrievalIO (span, inputData, outputData) {
    this._tagText(span, inputData, INPUT_VALUE)
    this._tagDocuments(span, outputData, OUTPUT_DOCUMENTS)
  }

  /**
   * Associates input and output values with the current span
   * @param {Span} span APM span
   * @param {string | Record<string, any>} [inputData] - the input value
   * @param {string | Record<string, any>} [outputData] - the output value
   */
  tagTextIO (span, inputData, outputData) {
    this._tagText(span, inputData, INPUT_VALUE)
    this._tagText(span, outputData, OUTPUT_VALUE)
  }

  /**
   * Associates metadata with the current span. New metadata will be merged with existing metadata.
   * @param {Span} span APM span
   * @param {Record<string, any>} metadata metadata object to associate with the span.
   */
  tagMetadata (span, metadata) {
    const existingMetadata = registry.get(span)?.[METADATA]
    if (existingMetadata) {
      Object.assign(existingMetadata, metadata)
    } else {
      this._setTag(span, METADATA, metadata)
    }
  }

  /**
   * Associates metrics with the current span. New metrics will be merged with existing metrics.
   * Handles the error of non-numeric values for metrics.
   * @param {Span} span APM span
   * @param {Record<string, number>} metrics metrics object to associate with the span
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
      }

      if (typeof value === 'number') {
        filterdMetrics[processedKey] = value
      } else {
        this._handleFailure(`Value for metric '${key}' must be a number, instead got ${value}`)
      }
    }

    const existingMetrics = registry.get(span)?.[METRICS]
    if (existingMetrics) {
      Object.assign(existingMetrics, filterdMetrics)
    } else {
      this._setTag(span, METRICS, filterdMetrics)
    }
  }

  /**
   * Associates tags with the current span. New tags will be merged with existing tags.
   * @param {Span} span APM span
   * @param {Record<string, string>} tags tags to associate with the span
   */
  tagSpanTags (span, tags) {
    const currentTags = registry.get(span)?.[TAGS]
    if (currentTags) {
      Object.assign(tags, currentTags)
    }
    this._setTag(span, TAGS, tags)
  }

  /**
   * Changes the span kind of an LLMObs span associated with the given APM span
   * @param {Span} span - APM span
   * @param {'llm'|'workflow'|'agent'|'tool'|'task'|'embedding'|'retrieval'} newKind - the new span kind
   */
  changeKind (span, newKind) {
    this._setTag(span, SPAN_KIND, newKind)
  }

  /**
   * Assigns text to the given key in the annotations associated with the span
   * @param {Span} span APM span
   * @param {string | Record<string, any>} [data] data to tag as a string
   * @param {string} key key to tag the data with
   */
  _tagText (span, data, key) {
    if (data) {
      if (typeof data === 'string') {
        this._setTag(span, key, data)
      } else {
        try {
          this._setTag(span, key, JSON.stringify(data))
        } catch {
          const type = key === INPUT_VALUE ? 'input' : 'output'
          this._handleFailure(`Failed to parse ${type} value, must be JSON serializable.`)
        }
      }
    }
  }

  /**
   * Assigns documents to the given key in the annotations associated with the span.
   * @param {Span} span APM span
   * @param {string | string[] | Document | Document[]} [data] data to tag as document(s)
   * @param {*} key key to tag the data with
   */
  _tagDocuments (span, data, key) {
    if (data) {
      const dataArr = Array.isArray(data) ? data : [data]

      const documents = dataArr.map(document => {
        if (typeof document === 'string') {
          return { text: document }
        }

        if (document == null || typeof document !== 'object') {
          this._handleFailure('Documents must be a string, object, or list of objects.')
          return undefined
        }

        const { text, name, id, score } = document
        let validDocument = true

        if (typeof text !== 'string') {
          this._handleFailure('Document text must be a string.')
          validDocument = false
        }

        const documentObj = { text }

        validDocument = this._tagConditionalString(name, 'Document name', documentObj, 'name') && validDocument
        validDocument = this._tagConditionalString(id, 'Document ID', documentObj, 'id') && validDocument
        validDocument = this._tagConditionalNumber(score, 'Document score', documentObj, 'score') && validDocument

        return validDocument ? documentObj : undefined
      }).filter(doc => !!doc)

      if (documents.length) {
        this._setTag(span, key, documents)
      }
    }
  }

  /**
   * Assigns messages to the given key in the annotations associated with the span.
   * @param {Span} span APM span
   * @param {string | string[] | Message | Message[]} [data] data to tag as message(s)
   * @param {string} key key to tag the data with
   */
  _tagMessages (span, data, key) {
    if (data) {
      const dataArr = Array.isArray(data) ? data : [data]

      const messages = dataArr.map(message => {
        if (typeof message === 'string') {
          return { content: message }
        }

        if (message == null || typeof message !== 'object') {
          this._handleFailure('Messages must be a string, object, or list of objects')
          return undefined
        }

        let validMessage = true

        const { content = '', role } = message
        let toolCalls = message.toolCalls
        const messageObj = { content }

        if (typeof content !== 'string') {
          this._handleFailure('Message content must be a string.')
          validMessage = false
        }

        validMessage = this._tagConditionalString(role, 'Message role', messageObj, 'role') && validMessage

        if (toolCalls) {
          if (!Array.isArray(toolCalls)) {
            toolCalls = [toolCalls]
          }

          const filteredToolCalls = toolCalls.map(toolCall => {
            if (typeof toolCall !== 'object') {
              this._handleFailure('Tool call must be an object.')
              return undefined
            }

            let validTool = true

            const { name, arguments: args, toolId, type } = toolCall
            const toolCallObj = {}

            validTool = this._tagConditionalString(name, 'Tool name', toolCallObj, 'name') && validTool
            validTool = this._tagConditionalObject(args, 'Tool arguments', toolCallObj, 'arguments') && validTool
            validTool = this._tagConditionalString(toolId, 'Tool ID', toolCallObj, 'tool_id') && validTool
            validTool = this._tagConditionalString(type, 'Tool type', toolCallObj, 'type') && validTool

            return validTool ? toolCallObj : undefined
          }).filter(toolCall => !!toolCall)

          if (filteredToolCalls.length) {
            messageObj.tool_calls = filteredToolCalls
          }
        }

        return validMessage ? messageObj : undefined
      }).filter(msg => !!msg)

      if (messages.length) {
        this._setTag(span, key, messages)
      }
    }
  }

  /**
   * Conditionally tags a string on the carrier with the given key.
   * If the string is not present, the carrier is not modified.
   * If the string is not a string, an error is handled.
   * @param {string} [data] data to tag as a string
   * @param {*} type type of data
   * @param {*} carrier object to tag
   * @param {*} key key to tag the data with
   * @returns {boolean} false if the data exists and is not a string, true otherwise
   */
  _tagConditionalString (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'string') {
      this._handleFailure(`"${type}" must be a string.`)
      return false
    }
    carrier[key] = data
    return true
  }

  /**
   * Conditionally tags a number on the carrier with the given key.
   * If the number is not present, the carrier is not modified.
   * If the number is not a number, an error is handled.
   * @param {number} [data] data to tag as a string
   * @param {*} type type of data
   * @param {*} carrier object to tag
   * @param {*} key key to tag the data with
   * @returns {boolean} false if the data exists and is not a number, true otherwise
   */
  _tagConditionalNumber (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'number') {
      this._handleFailure(`"${type}" must be a number.`)
      return false
    }
    carrier[key] = data
    return true
  }

  /**
   * Conditionally tags an object on the carrier with the given key.
   * If the object is not present, the carrier is not modified.
   * If the object is not an object, an error is handled.
   * @param {Record<unknown, string>} [data] data to tag as a object
   * @param {*} type type of data
   * @param {*} carrier object to tag
   * @param {*} key key to tag the data with
   * @returns {boolean} false if the data exists and is not an object, true otherwise
   */
  _tagConditionalObject (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'object') {
      this._handleFailure(`"${type}" must be an object.`)
      return false
    }
    carrier[key] = data
    return true
  }

  /**
   * Handles a failure in the LLMObs tagger according to this instance's softFail setting.
   * Any public-facing LLMObs APIs using this tagger should not soft fail, throwing an Error.
   * Auto-instrumentation should soft fail, just logging the message.
   * @param {string} msg - the error message
   * @throws if the tagger is not set to soft fail
   */
  _handleFailure (msg) {
    if (this.softFail) {
      log.warn(msg)
    } else {
      throw new Error(msg)
    }
  }

  /**
   * Registers an APM span as an LLMObs span.
   * Fails if the span is already registered.
   * @param {Span} span APM span to register
   */
  _register (span) {
    if (!this._config.llmobs.enabled) return
    if (registry.has(span)) {
      this._handleFailure(`LLMObs Span "${span._name}" already registered.`)
      return
    }

    registry.set(span, {})
  }

  /**
   * Sets a tag associated with an APM span, which is a property of an LLM Observability span event.
   * If the APM span is not an LLMObs span, fails.
   * @param {Span} span APM span to associate the tag with
   * @param {*} key tag key
   * @param {*} value tag value
   */
  _setTag (span, key, value) {
    if (!this._config.llmobs.enabled) return
    if (!registry.has(span)) {
      this._handleFailure(`Span "${span._name}" must be an LLMObs generated span.`)
      return
    }

    const tagsCarrier = registry.get(span)
    Object.assign(tagsCarrier, { [key]: value })
  }
}

module.exports = LLMObsTagger

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

  // TODO: similarly for the following `tag` methods,
  // how can we transition from a span weakmap to core API functionality
  tagLLMIO (span, inputData, outputData) {
    this._tagMessages(span, inputData, INPUT_MESSAGES)
    this._tagMessages(span, outputData, OUTPUT_MESSAGES)
  }

  tagEmbeddingIO (span, inputData, outputData) {
    this._tagDocuments(span, inputData, INPUT_DOCUMENTS)
    this._tagText(span, outputData, OUTPUT_VALUE)
  }

  tagRetrievalIO (span, inputData, outputData) {
    this._tagText(span, inputData, INPUT_VALUE)
    this._tagDocuments(span, outputData, OUTPUT_DOCUMENTS)
  }

  tagTextIO (span, inputData, outputData) {
    this._tagText(span, inputData, INPUT_VALUE)
    this._tagText(span, outputData, OUTPUT_VALUE)
  }

  tagMetadata (span, metadata) {
    this._setTag(span, METADATA, metadata)
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
        this._handleFailure(`Value for metric '${key}' must be a number, instead got ${value}`)
      }
    }

    this._setTag(span, METRICS, filterdMetrics)
  }

  tagSpanTags (span, tags) {
    // new tags will be merged with existing tags
    const currentTags = registry.get(span)?.[TAGS]
    if (currentTags) {
      Object.assign(tags, currentTags)
    }
    this._setTag(span, TAGS, tags)
  }

  changeKind (span, newKind) {
    this._setTag(span, SPAN_KIND, newKind)
  }

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

  _tagDocuments (span, data, key) {
    if (data) {
      if (!Array.isArray(data)) {
        data = [data]
      }

      const documents = data.map(document => {
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

  _tagMessages (span, data, key) {
    if (data) {
      if (!Array.isArray(data)) {
        data = [data]
      }

      const messages = data.map(message => {
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

  _tagConditionalString (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'string') {
      this._handleFailure(`"${type}" must be a string.`)
      return false
    }
    carrier[key] = data
    return true
  }

  _tagConditionalNumber (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'number') {
      this._handleFailure(`"${type}" must be a number.`)
      return false
    }
    carrier[key] = data
    return true
  }

  _tagConditionalObject (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'object') {
      this._handleFailure(`"${type}" must be an object.`)
      return false
    }
    carrier[key] = data
    return true
  }

  // any public-facing LLMObs APIs using this tagger should not soft fail
  // auto-instrumentation should soft fail
  _handleFailure (msg) {
    if (this.softFail) {
      log.warn(msg)
    } else {
      throw new Error(msg)
    }
  }

  _register (span) {
    if (!this._config.llmobs.enabled) return
    if (registry.has(span)) {
      this._handleFailure(`LLMObs Span "${span._name}" already registered.`)
      return
    }

    registry.set(span, {})
  }

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

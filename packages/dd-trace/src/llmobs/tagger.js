'use strict'

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
  ROOT_PARENT_ID
} = require('./constants')

// maps spans to tag annotations
const tagMap = new WeakMap()

function setTag (span, key, value) {
  const tagsCarrier = tagMap.get(span) || {}
  Object.assign(tagsCarrier, { [key]: value })
  if (!tagMap.has(span)) tagMap.set(span, tagsCarrier)
}

class LLMObsTagger {
  constructor (config) {
    this._config = config
  }

  static get tagMap () {
    return tagMap
  }

  // TODO: we're using a weakmap registry of LLMObs spans for now, how can this be used in the core API?
  setLLMObsSpanTags (
    span,
    kind,
    { modelName, modelProvider, sessionId, mlApp, parentLLMObsSpan } = {},
    name
  ) {
    if (!this._config.llmobs.enabled) return
    if (!kind) return // do not register it in the map if it doesn't have an llmobs span kind
    if (name) setTag(span, NAME, name)

    setTag(span, SPAN_KIND, kind)
    if (modelName) setTag(span, MODEL_NAME, modelName)
    if (modelProvider) setTag(span, MODEL_PROVIDER, modelProvider)

    sessionId = sessionId || parentLLMObsSpan?.context()._tags[SESSION_ID]
    if (sessionId) setTag(span, SESSION_ID, sessionId)

    if (!mlApp) mlApp = parentLLMObsSpan?.context()._tags[ML_APP] || this._config.llmobs.mlApp
    setTag(span, ML_APP, mlApp)

    const parentId =
      parentLLMObsSpan?.context().toSpanId() ||
      span.context()._trace.tags[PROPAGATED_PARENT_ID_KEY] ||
      ROOT_PARENT_ID
    setTag(span, PARENT_ID_KEY, parentId)
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
    setTag(span, METADATA, metadata)
  }

  tagMetrics (span, metrics) {
    const filterdMetrics = {}
    for (const [key, value] of Object.entries(metrics)) {
      let processedKey = key

      // processing these specifically for our metrics ingestion
      switch (key) {
        case 'inputTokens':
          processedKey = 'input_tokens'
          break
        case 'outputTokens':
          processedKey = 'output_tokens'
          break
        case 'totalTokens':
          processedKey = 'total_tokens'
          break
      }

      if (typeof value === 'number') {
        filterdMetrics[processedKey] = value
      } else {
        throw new Error(`Value for metric '${key}' must be a number, instead got ${value}`)
      }
    }

    setTag(span, METRICS, filterdMetrics)
  }

  tagSpanTags (span, tags) {
    // new tags will be merged with existing tags
    const currentTags = tagMap.get(span)?.[TAGS]
    if (currentTags) {
      Object.assign(tags, currentTags)
    }
    setTag(span, TAGS, tags)
  }

  _tagText (span, data, key) {
    if (data) {
      if (typeof data === 'string') {
        setTag(span, key, data)
      } else {
        try {
          setTag(span, key, JSON.stringify(data))
        } catch {
          const type = key === INPUT_VALUE ? 'input' : 'output'
          throw new Error(`Failed to parse ${type} value, must be JSON serializable.`)
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
          throw new Error('Documents must be a string, object, or list of objects.')
        }

        const { text, name, id, score } = document

        if (typeof text !== 'string') {
          throw new Error('Document text must be a string.')
        }

        const documentObj = { text }

        this._tagConditionalString(name, 'Document name', documentObj, 'name')
        this._tagConditionalString(id, 'Document ID', documentObj, 'id')
        this._tagConditionalNumber(score, 'Document score', documentObj, 'score')

        return documentObj
      }).filter(doc => !!doc)

      if (documents.length) {
        setTag(span, key, documents)
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
          throw new Error('Messages must be a string, object, or list of objects')
        }

        const { content = '', role } = message
        let toolCalls = message.toolCalls
        const messageObj = { content }

        if (typeof content !== 'string') {
          throw new Error('Message content must be a string.')
        }

        this._tagConditionalString(role, 'Message role', messageObj, 'role')

        if (toolCalls) {
          if (!Array.isArray(toolCalls)) {
            toolCalls = [toolCalls]
          }

          const filteredToolCalls = toolCalls.map(toolCall => {
            if (typeof toolCall !== 'object') {
              throw new Error('Tool call must be an object.')
            }

            const { name, arguments: args, toolId, type } = toolCall
            const toolCallObj = {}

            this._tagConditionalString(name, 'Tool name', toolCallObj, 'name')
            this._tagConditionalObject(args, 'Tool arguments', toolCallObj, 'arguments')
            this._tagConditionalString(toolId, 'Tool ID', toolCallObj, 'tool_id')
            this._tagConditionalString(type, 'Tool type', toolCallObj, 'type')

            return toolCallObj
          }).filter(toolCall => !!toolCall)

          if (filteredToolCalls.length) {
            messageObj.tool_calls = filteredToolCalls
          }
        }

        return messageObj
      }).filter(msg => !!msg)

      if (messages.length) {
        setTag(span, key, messages)
      }
    }
  }

  _tagConditionalString (data, type, carrier, key) {
    if (!data) return
    if (typeof data !== 'string') {
      throw new Error(`${type} must be a string.`)
    }
    carrier[key] = data
  }

  _tagConditionalNumber (data, type, carrier, key) {
    if (!data) return
    if (typeof data !== 'number') {
      throw new Error(`${type} must be a number.`)
    }
    carrier[key] = data
  }

  _tagConditionalObject (data, type, carrier, key) {
    if (!data) return
    if (typeof data !== 'object') {
      throw new Error(`${type} must be an object.`)
    }
    carrier[key] = data
  }
}

module.exports = LLMObsTagger

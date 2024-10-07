'use strict'

const logger = require('../log')
const {
  SPAN_TYPE
} = require('../../../../ext/tags')
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

class LLMObsTagger {
  constructor (config) {
    this._config = config
  }

  // TODO: instead of passing in the span here, can we pass in a namespaced object?
  setLLMObsSpanTags (
    span,
    kind,
    { modelName, modelProvider, sessionId, mlApp, parentLLMObsSpan } = {},
    name
  ) {
    if (!this._config.llmobs.enabled) return
    if (kind) span.setTag(SPAN_TYPE, 'llm') // only mark it as an llm span if it was a valid kind
    if (name) span.setTag(NAME, name)

    span.setTag(SPAN_KIND, kind)
    if (modelName) span.setTag(MODEL_NAME, modelName)
    if (modelProvider) span.setTag(MODEL_PROVIDER, modelProvider)

    sessionId = sessionId || parentLLMObsSpan?.context()._tags[SESSION_ID]
    if (sessionId) span.setTag(SESSION_ID, sessionId)

    if (!mlApp) mlApp = parentLLMObsSpan?.context()._tags[ML_APP] || this._config.llmobs.mlApp
    span.setTag(ML_APP, mlApp)

    const parentId =
      parentLLMObsSpan?.context().toSpanId() ||
      span.context()._trace.tags[PROPAGATED_PARENT_ID_KEY] ||
      ROOT_PARENT_ID
    span.setTag(PARENT_ID_KEY, parentId)
  }

  // TODO: similarly for the following `tag` methods, can we pass in a namespaced object instead of the span?
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
    span.setTag(METADATA, metadata)
  }

  tagMetrics (span, metrics) {
    const filterdMetrics = {}
    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value === 'number') {
        filterdMetrics[key] = value
      } else {
        logger.warn(`Value for metric '${key}' must be a number, instead got ${value}`)
      }
    }

    span.setTag(METRICS, filterdMetrics)
  }

  tagSpanTags (span, tags) {
    // new tags will be merged with existing tags
    const currentTags = span.context()._tags[TAGS]
    if (currentTags) {
      Object.assign(tags, currentTags)
    }
    span.setTag(TAGS, tags)
  }

  _tagText (span, data, key) {
    if (data) {
      if (typeof data === 'string') {
        span.setTag(key, data)
      } else {
        try {
          span.setTag(key, JSON.stringify(data))
        } catch {
          const type = key === INPUT_VALUE ? 'input' : 'output'
          logger.warn(`Failed to parse ${type} value, must be JSON serializable.`)
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
          logger.warn('Documents must be a string, object, or list of objects.')
          return undefined
        }

        const { text, name, id, score } = document

        if (typeof text !== 'string') {
          logger.warn('Document text must be a string.')
          return undefined
        }

        const documentObj = { text }

        const validName = this._tagConditionalString(name, 'Document name', documentObj, 'name')
        if (!validName) return undefined

        const validId = this._tagConditionalString(id, 'Document ID', documentObj, 'id')
        if (!validId) return undefined

        const validScore = this._tagConditionalNumber(score, 'Document score', documentObj, 'score')
        if (!validScore) return undefined

        return documentObj
      }).filter(doc => !!doc)

      span.setTag(key, documents)
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
          logger.warn('Messages must be a string, object, or list of objects')
          return undefined
        }

        const { content = '', role } = message
        let toolCalls = message.toolCalls
        const messageObj = { content }

        if (typeof content !== 'string') {
          logger.warn('Message content must be a string.')
          return undefined
        }

        const validRole = this._tagConditionalString(role, 'Message role', messageObj, 'role')
        if (!validRole) return undefined

        if (toolCalls) {
          if (!Array.isArray(toolCalls)) {
            toolCalls = [toolCalls]
          }

          const filteredToolCalls = toolCalls.map(toolCall => {
            if (typeof toolCall !== 'object') {
              logger.warn('Tool call must be an object.')
              return undefined
            }

            const { name, arguments: args, toolId, type } = toolCall
            const toolCallObj = {}

            const validName = this._tagConditionalString(name, 'Tool name', toolCallObj, 'name')
            if (!validName) return undefined

            const validArgs = this._tagConditionalObject(args, 'Tool arguments', toolCallObj, 'arguments')
            if (!validArgs) return undefined

            const validToolId = this._tagConditionalString(toolId, 'Tool ID', toolCallObj, 'toolId')
            if (!validToolId) return undefined

            const validType = this._tagConditionalString(type, 'Tool type', toolCallObj, 'type')
            if (!validType) return undefined

            return toolCallObj
          }).filter(toolCall => !!toolCall)

          if (filteredToolCalls.length) {
            messageObj.tool_calls = filteredToolCalls
          }
        }

        return messageObj
      }).filter(msg => !!msg)

      if (messages.length) {
        span.setTag(key, messages)
      }
    }
  }

  _tagConditionalString (data, type, carrier, key) {
    // returning true here means we won't dropt the whole object (message/document)
    // if the field isn't there
    if (!data) return true
    if (typeof data !== 'string') {
      logger.warn(`${type} must be a string.`)
      return false
    }
    carrier[key] = data
    return true
  }

  _tagConditionalNumber (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'number') {
      logger.warn(`${type} must be a number.`)
      return false
    }
    carrier[key] = data
    return true
  }

  _tagConditionalObject (data, type, carrier, key) {
    if (!data) return true
    if (typeof data !== 'object') {
      logger.warn(`${type} must be an object.`)
      return false
    }
    carrier[key] = data
    return true
  }
}

module.exports = LLMObsTagger

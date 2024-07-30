'use strict'

const {
  SPAN_TYPE
} = require('../../../../ext/tags')
const {
  PROPAGATED_PARENT_ID_KEY,
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
  OUTPUT_MESSAGES
} = require('./constants')

const {
  validateKind,
  getName,
  getLLMObsParentId,
  getMlApp,
  isLLMSpan,
  getSessionId
} = require('./utils')

class LLMObsTagger {
  constructor (config) {
    this._config = config
  }

  setLLMObsSpanTags (span, kind, { modelName, modelProvider, sessionId, mlApp }) {
    span.setTag(SPAN_TYPE, 'llm')

    span.setTag(SPAN_KIND, kind)
    if (modelName) span.setTag(MODEL_NAME, modelName)
    if (modelProvider) span.setTag(MODEL_PROVIDER, modelProvider)

    if (!sessionId) sessionId = getSessionId(span)
    span.setTag(SESSION_ID, sessionId)

    if (!mlApp) mlApp = getMlApp(span, this._config.llmobs.mlApp)
    span.setTag(ML_APP, mlApp)

    if (!span.context()._tags[PROPAGATED_PARENT_ID_KEY]) {
      const parentId = getLLMObsParentId(span) || 'undefined'
      span.setTag(PARENT_ID_KEY, parentId)
    }
  }

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
    try {
      span.setTag(METADATA, JSON.stringify(metadata))
    } catch {
      // log error
    }
  }

  tagMetrics (span, metrics) {
    try {
      span.setTag(METRICS, JSON.stringify(metrics))
    } catch {
      // log error
    }
  }

  tagSpanTags (span, tags) {}

  _tagText (span, data, key) {
    if (data) {
      if (typeof data === 'string') {
        span.setTag(key, data)
      } else {
        try {
          span.setTag(key, JSON.stringify(data))
        } catch {
          // log error
        }
      }
    }
  }

  _tagDocuments (span, data, key) {
    if (data) {
      if (!Array.isArray(data)) {
        data = [data]
      }

      try {
        const documents = data.map(document => {
          if (typeof document === 'string') {
            return document
          }

          const { text, name, id, score } = document

          if (text && typeof text !== 'string') return undefined

          if (name && typeof name !== 'string') return undefined

          if (id && typeof id !== 'string') return undefined

          if (score && typeof score !== 'number') {
            return undefined
          }

          return document
        }).filter(doc => !!doc) // filter out bad documents?

        span.setTag(key, JSON.stringify(documents))
      } catch {
        // log error
      }
    }
  }

  _tagMessages (span, data, key) {
    if (data) {
      if (!Array.isArray(data)) {
        data = [data]
      }

      try {
        const messages = data.map(message => {
          if (typeof message === 'string') {
            return message
          }

          const content = message.content || ''
          const role = message.role

          if (typeof content !== 'string') {
            return undefined
          }

          if (role && typeof role !== 'string') {
            return undefined
          }

          return message
        }).filter(msg => !!msg) // filter out bad messages?

        span.setTag(key, JSON.stringify(messages))
      } catch {
        // log error
      }
    }
  }
}

module.exports = LLMObsTagger

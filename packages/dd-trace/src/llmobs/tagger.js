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
  TRACE_ID,
  PROPAGATED_TRACE_ID_KEY
} = require('./constants')
const { generateTraceId } = require('./util')

class LLMObsTagger {
  constructor (config) {
    this._config = config

    // this can be expanded on by config options later?
    this._serializers = {
      Promise: (promise) => promise.toString()
    }
  }

  setLLMObsSpanTags (
    span,
    kind,
    { modelName, modelProvider, sessionId, mlApp, parentLLMObsSpan } = {},
    name
  ) {
    if (kind) span.setTag(SPAN_TYPE, 'llm') // only mark it as an llm span if it was a valid kind
    if (name) span.setTag(NAME, name)

    span.setTag(SPAN_KIND, kind)
    if (modelName) span.setTag(MODEL_NAME, modelName)
    if (modelProvider) span.setTag(MODEL_PROVIDER, modelProvider)

    if (!parentLLMObsSpan) {
      const maybePropagatedTraceId = span.context()._trace.tags[PROPAGATED_TRACE_ID_KEY]
      if (maybePropagatedTraceId) {
        span.setTag(TRACE_ID, maybePropagatedTraceId)
      } else {
        // making this 128 bit by default
        const traceId = generateTraceId()
        span.setTag(TRACE_ID, traceId)
      }
    } else {
      span.setTag(TRACE_ID, parentLLMObsSpan.context()._tags[TRACE_ID])
    }

    sessionId = sessionId || parentLLMObsSpan?.context()._tags[SESSION_ID]
    if (sessionId) span.setTag(SESSION_ID, sessionId)

    if (!mlApp) mlApp = parentLLMObsSpan?.context()._tags[ML_APP] || this._config.llmobs.mlApp
    span.setTag(ML_APP, mlApp)

    const parentId =
      parentLLMObsSpan?.context().toSpanId() ||
      span.context()._trace.tags[PROPAGATED_PARENT_ID_KEY] ||
      'undefined'
    span.setTag(PARENT_ID_KEY, parentId)
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
      span.setTag(METADATA, this._stringify(metadata))
    } catch {
      logger.warn('Failed to parse span metadata. Metadata key-value pairs must be JSON serializable.')
    }
  }

  tagMetrics (span, metrics) {
    try {
      span.setTag(METRICS, this._stringify(metrics))
    } catch {
      logger.warn('Failed to parse span metrics. Metrics key-value pairs must be JSON serializable.')
    }
  }

  tagSpanTags (span, tags) {
    try {
      const currentTags = span.context()._tags[TAGS]
      if (currentTags) {
        Object.assign(tags, currentTags)
      }
      span.setTag(TAGS, this._stringify(tags))
    } catch {
      logger.warn('Failed to parse span tags. Tag key-value pairs must be JSON serializable.')
    }
  }

  _tagText (span, data, key) {
    if (data) {
      if (typeof data === 'string') {
        span.setTag(key, data)
      } else {
        try {
          // this will help showcase unfinished promises being passed in as values
          span.setTag(key, this._stringify(data))
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

        span.setTag(key, this._stringify(documents))
      } catch {
        const type = key === INPUT_DOCUMENTS ? 'input' : 'output'
        logger.warn(`Failed to parse ${type} documents.`)
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

          message.content = content

          if (role && typeof role !== 'string') {
            return undefined
          }

          return message
        }).filter(msg => !!msg) // filter out bad messages?

        span.setTag(key, this._stringify(messages))
      } catch {
        const type = key === INPUT_MESSAGES ? 'input' : 'output'
        logger.warn(`Failed to parse ${type} messages.`)
      }
    }
  }

  _stringify (data) {
    return JSON.stringify(data, (_, value) => {
      const instance = value?.constructor?.name // some kind of object
      if (instance && this._serializers[instance]) {
        return this._serializers[instance](value)
      }

      return value
    })
  }
}

module.exports = LLMObsTagger

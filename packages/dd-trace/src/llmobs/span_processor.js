'use strict'

const {
  SPAN_KIND,
  MODEL_NAME,
  MODEL_PROVIDER,
  METADATA,
  INPUT_MESSAGES,
  INPUT_VALUE,
  OUTPUT_MESSAGES,
  INPUT_DOCUMENTS,
  OUTPUT_DOCUMENTS,
  OUTPUT_VALUE,
  METRICS,
  ML_APP,
  TAGS,
  PARENT_ID_KEY,
  SESSION_ID,
  NAME
} = require('./constants/tags')
const { UNSERIALIZABLE_VALUE_TEXT } = require('./constants/text')

const {
  ERROR_MESSAGE,
  ERROR_TYPE,
  ERROR_STACK
} = require('../constants')

const LLMObsTagger = require('./tagger')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')

class LLMObsSpanProcessor {
  constructor (config) {
    this._config = config
  }

  setWriter (writer) {
    this._writer = writer
  }

  // TODO: instead of relying on the tagger's weakmap registry, can we use some namespaced storage correlation?
  process ({ span }) {
    if (!this._config.llmobs.enabled) return
    // if the span is not in our private tagger map, it is not an llmobs span
    if (!LLMObsTagger.tagMap.has(span)) return

    try {
      const formattedEvent = this.format(span)
      this._writer.append(formattedEvent)
    } catch (e) {
      // this should be a rare case
      // we protect against unserializable properties in the format function, and in
      // safeguards in the tagger
      logger.warn(`
        Failed to append span to LLM Observability writer, likely due to an unserializable property.
        Span won't be sent to LLM Observability: ${e.message}
      `)
    }
  }

  format (span) {
    const spanTags = span.context()._tags
    const mlObsTags = LLMObsTagger.tagMap.get(span)

    const spanKind = mlObsTags[SPAN_KIND]

    const meta = { 'span.kind': spanKind, input: {}, output: {} }
    const input = {}
    const output = {}

    if (['llm', 'embedding'].includes(spanKind)) {
      meta.model_name = mlObsTags[MODEL_NAME] || 'custom'
      meta.model_provider = (mlObsTags[MODEL_PROVIDER] || 'custom').toLowerCase()
    }
    if (mlObsTags[METADATA]) {
      this._addObject(mlObsTags[METADATA], meta.metadata = {})
    }
    if (spanKind === 'llm' && mlObsTags[INPUT_MESSAGES]) {
      input.messages = mlObsTags[INPUT_MESSAGES]
    }
    if (mlObsTags[INPUT_VALUE]) {
      input.value = mlObsTags[INPUT_VALUE]
    }
    if (spanKind === 'llm' && mlObsTags[OUTPUT_MESSAGES]) {
      output.messages = mlObsTags[OUTPUT_MESSAGES]
    }
    if (spanKind === 'embedding' && mlObsTags[INPUT_DOCUMENTS]) {
      input.documents = mlObsTags[INPUT_DOCUMENTS]
    }
    if (mlObsTags[OUTPUT_VALUE]) {
      output.value = mlObsTags[OUTPUT_VALUE]
    }
    if (spanKind === 'retrieval' && mlObsTags[OUTPUT_DOCUMENTS]) {
      output.documents = mlObsTags[OUTPUT_DOCUMENTS]
    }

    const error = spanTags.error || spanTags[ERROR_TYPE]
    if (error) {
      meta[ERROR_MESSAGE] = spanTags[ERROR_MESSAGE] || error.message || error.code
      meta[ERROR_TYPE] = spanTags[ERROR_TYPE] || error.name
      meta[ERROR_STACK] = spanTags[ERROR_STACK] || error.stack
    }

    if (input) meta.input = input
    if (output) meta.output = output

    const metrics = mlObsTags[METRICS] || {}

    const mlApp = mlObsTags[ML_APP]
    const sessionId = mlObsTags[SESSION_ID]
    const parentId = mlObsTags[PARENT_ID_KEY]

    const name = mlObsTags[NAME] || span._name

    const llmObsSpanEvent = {
      trace_id: span.context().toTraceId(true),
      span_id: span.context().toSpanId(),
      parent_id: parentId,
      name,
      tags: this._processTags(span, mlApp, sessionId, error),
      start_ns: Math.round(span._startTime * 1e6),
      duration: Math.round(span._duration * 1e6),
      status: error ? 'error' : 'ok',
      meta,
      metrics,
      _dd: {
        span_id: span.context().toSpanId(),
        trace_id: span.context().toTraceId(true)
      }
    }

    if (sessionId) llmObsSpanEvent.session_id = sessionId

    return llmObsSpanEvent
  }

  // For now, this only applies to metadata, as we let users annotate this field with any object
  // However, we want to protect against circular references or BigInts (unserializable)
  // This function can be reused for other fields if needed
  // Messages, Documents, and Metrics are safeguarded in `llmobs/tagger.js`
  _addObject (obj, carrier) {
    const seenObjects = new WeakSet()
    seenObjects.add(obj) // capture root object

    const isCircular = value => {
      if (typeof value !== 'object') return false
      if (seenObjects.has(value)) return true
      seenObjects.add(value)
      return false
    }

    const add = (obj, carrier) => {
      for (const key in obj) {
        const value = obj[key]
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue
        if (typeof value === 'bigint' || isCircular(value)) {
          // mark as unserializable instead of dropping
          logger.warn(`Unserializable property found in metadata: ${key}`)
          carrier[key] = UNSERIALIZABLE_VALUE_TEXT
          continue
        }
        if (typeof value === 'object') {
          add(value, carrier[key] = {})
        } else {
          carrier[key] = value
        }
      }
    }

    add(obj, carrier)
  }

  _processTags (span, mlApp, sessionId, error) {
    let tags = {
      version: this._config.version,
      env: this._config.env,
      service: this._config.service,
      source: 'integration',
      ml_app: mlApp,
      'ddtrace.version': tracerVersion,
      error: Number(!!error) || 0,
      language: 'javascript'
    }
    const errType = span.context()._tags[ERROR_TYPE] || error?.name
    if (errType) tags.error_type = errType
    if (sessionId) tags.session_id = sessionId
    const existingTags = LLMObsTagger.tagMap.get(span)?.[TAGS] || {}
    if (existingTags) tags = { ...tags, ...existingTags }
    return Object.entries(tags).map(([key, value]) => `${key}:${value ?? ''}`)
  }
}

module.exports = LLMObsSpanProcessor

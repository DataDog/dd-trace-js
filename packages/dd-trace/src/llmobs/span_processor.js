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
  NAME,
  UNSERIALIZABLE_VALUE_TEXT
} = require('./constants')

const {
  ERROR_MESSAGE,
  ERROR_TYPE,
  ERROR_STACK
} = require('../constants')

const AgentlessWriter = require('./writers/spans/agentless')
const AgentProxyWriter = require('./writers/spans/agentProxy')
const { isLLMSpan } = require('./util')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')

class LLMObsSpanProcessor {
  constructor (config) {
    this._config = config
    const { llmobs } = config

    if (llmobs.enabled) {
      const LLMObsSpanWriter = llmobs.agentlessEnabled ? AgentlessWriter : AgentProxyWriter
      this._writer = new LLMObsSpanWriter(config)
    }
  }

  process (span) {
    if (!this._config.llmobs.enabled) return
    if (!isLLMSpan(span)) return
    const formattedEvent = this.format(span)

    try {
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
    const tags = span.context()._tags
    const spanKind = tags[SPAN_KIND]

    const meta = { 'span.kind': spanKind, input: {}, output: {} }
    const input = {}
    const output = {}

    if (['llm', 'embedding'].includes(spanKind) && tags[MODEL_NAME]) {
      meta.model_name = tags[MODEL_NAME]
      meta.model_provider = (tags[MODEL_PROVIDER] || 'custom').toLowerCase()
    }
    if (tags[METADATA]) {
      this._addObject(tags[METADATA], meta.metadata = {})
    }
    if (spanKind === 'llm' && tags[INPUT_MESSAGES]) {
      input.messages = tags[INPUT_MESSAGES]
    }
    if (tags[INPUT_VALUE]) {
      input.value = tags[INPUT_VALUE]
    }
    if (spanKind === 'llm' && tags[OUTPUT_MESSAGES]) {
      output.messages = tags[OUTPUT_MESSAGES]
    }
    if (spanKind === 'embedding' && tags[INPUT_DOCUMENTS]) {
      input.documents = tags[INPUT_DOCUMENTS]
    }
    if (tags[OUTPUT_VALUE]) {
      output.value = tags[OUTPUT_VALUE]
    }
    if (spanKind === 'retrieval' && tags[OUTPUT_DOCUMENTS]) {
      output.documents = tags[OUTPUT_DOCUMENTS]
    }

    const error = tags.error
    if (error) {
      meta[ERROR_MESSAGE] = tags[ERROR_MESSAGE] || error.message || error.code
      meta[ERROR_TYPE] = tags[ERROR_TYPE] || error.name
      meta[ERROR_STACK] = tags[ERROR_STACK] || error.stack
    }

    if (input) meta.input = input
    if (output) meta.output = output

    const metrics = tags[METRICS] || {}

    const mlApp = tags[ML_APP]
    const sessionId = tags[SESSION_ID]
    const parentId = tags[PARENT_ID_KEY]

    const name = tags[NAME] || span._name

    const llmObsSpanEvent = {
      trace_id: span.context().toTraceId(true),
      span_id: span.context().toSpanId(),
      parent_id: parentId,
      name,
      tags: this._processTags(span, mlApp, sessionId, error),
      start_ns: Math.round(span._startTime * 1e6),
      duration: Math.round(span._duration * 1e6),
      status: tags.error ? 'error' : 'ok',
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
      'dd-trace.version': tracerVersion,
      error: Number(!!error) || 0,
      language: 'javascript'
    }
    const errType = span.context()._tags[ERROR_TYPE] || error?.name
    if (errType) tags.error_type = errType
    if (sessionId) tags.session_id = sessionId
    const existingTags = span.context()._tags[TAGS] || {}
    if (existingTags) tags = { ...tags, ...existingTags }
    return Object.entries(tags).map(([key, value]) => `${key}:${value ?? ''}`)
  }
}

module.exports = LLMObsSpanProcessor

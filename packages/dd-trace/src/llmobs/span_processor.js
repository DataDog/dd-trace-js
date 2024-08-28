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
    const payload = this._process(span)

    this._writer.append(payload)
  }

  _process (span) {
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
      meta.metadata = JSON.parse(tags[METADATA])
    }
    if (spanKind === 'llm' && tags[INPUT_MESSAGES]) {
      input.messages = JSON.parse(tags[INPUT_MESSAGES])
    }
    if (tags[INPUT_VALUE]) {
      input.value = tags[INPUT_VALUE]
    }
    if (spanKind === 'llm' && tags[OUTPUT_MESSAGES]) {
      output.messages = JSON.parse(tags[OUTPUT_MESSAGES])
    }
    if (spanKind === 'embedding' && tags[INPUT_DOCUMENTS]) {
      input.documents = JSON.parse(tags[INPUT_DOCUMENTS])
    }
    if (tags[OUTPUT_VALUE]) {
      output.value = tags[OUTPUT_VALUE]
    }
    if (spanKind === 'retrieval' && tags[OUTPUT_DOCUMENTS]) {
      output.documents = JSON.parse(tags[OUTPUT_DOCUMENTS])
    }
    if (tags.error) {
      meta[ERROR_MESSAGE] = tags[ERROR_MESSAGE]
      meta[ERROR_TYPE] = tags[ERROR_TYPE]
      meta[ERROR_STACK] = tags[ERROR_STACK]
    }

    if (input) meta.input = input
    if (output) meta.output = output

    const metrics = JSON.parse(tags[METRICS] || '{}')

    // TODO: remove when not walking up the trace anymore
    // this will be stitched together on the backend

    const mlApp = tags[ML_APP]
    const sessionId = tags[SESSION_ID]
    const parentId = tags[PARENT_ID_KEY]

    const name = tags[NAME] || span._name

    const llmObsSpanEvent = {
      trace_id: span.context().toTraceId(true),
      span_id: span.context().toSpanId(),
      parent_id: parentId,
      name,
      tags: this._processTags(span, mlApp, sessionId),
      start_ns: span._startTime * 1e6,
      duration: span._duration * 1e6,
      status: tags.error ? 'error' : 'ok',
      meta,
      metrics
    }

    if (sessionId) llmObsSpanEvent.session_id = sessionId

    return llmObsSpanEvent
  }

  _processTags (span, mlApp, sessionId) {
    let tags = {
      version: this._config.version,
      env: this._config.env,
      service: this._config.service,
      source: 'integration',
      ml_app: mlApp,
      'dd-trace.version': tracerVersion,
      error: span.error,
      language: 'javascript'
    }
    const errType = span.context()._tags[ERROR_TYPE]
    if (errType) tags.error_type = errType
    if (sessionId) tags.session_id = sessionId
    const existingTags = JSON.parse(tags[TAGS] || '{}')
    if (existingTags) tags = { ...tags, ...existingTags }
    return Object.entries(tags).map(([key, value]) => `${key}:${value}`)
  }
}

module.exports = LLMObsSpanProcessor

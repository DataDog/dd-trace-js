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
  SESSION_ID
} = require('./constants')

const {
  ERROR_MESSAGE,
  ERROR_TYPE,
  ERROR_STACK
} = require('../constants')

const { getMlApp, getLLMObsParentId, getSessionId } = require('./utils')
const Writer = require('./writers/span')

const { DD_MAJOR, DD_MINOR, DD_PATCH } = require('../../../../version')
const TRACER_VERSION = `${DD_MAJOR}.${DD_MINOR}.${DD_PATCH}`

class LLMObsSpanProcessor {
  constructor (config) {
    this._config = config
    this._writer = new Writer(
      config.site,
      config.apiKey
    )
  }

  process (span, formattedSpan) {
    if (!this._config.llmobs.enabled) return
    if (formattedSpan.type !== 'llm') return
    const payload = this._process(span, formattedSpan)

    this._writer.append(payload)
  }

  _process (span, formattedSpan) {
    const tags = formattedSpan.meta
    const spanKind = this._pop(tags, SPAN_KIND)

    const meta = { 'span.kind': spanKind, input: {}, output: {} }

    if (['llm', 'embedding'].includes(spanKind) && tags[MODEL_NAME]) {
      meta.model_name = this._pop(tags, MODEL_NAME)
      meta.model_provider = this._pop(tags, MODEL_PROVIDER, 'custom').toLowerCase()
    }
    if (tags[METADATA]) {
      meta.metadata = JSON.stringify(this._pop(tags, METADATA))
    }
    if (spanKind === 'llm' && tags[INPUT_MESSAGES]) {
      meta.input.messages = JSON.stringify(this._pop(tags, INPUT_MESSAGES))
    }
    if (tags[INPUT_VALUE]) {
      meta.input.value = this._pop(tags, INPUT_VALUE)
    }
    if (spanKind === 'llm' && tags[OUTPUT_MESSAGES]) {
      meta.output.messages = JSON.stringify(this._pop(tags, OUTPUT_MESSAGES))
    }
    if (spanKind === 'embedding' && tags[INPUT_DOCUMENTS]) {
      meta.input.documents = JSON.stringify(this._pop(tags, INPUT_DOCUMENTS))
    }
    if (tags[OUTPUT_VALUE]) {
      meta.output.value = this._pop(tags, OUTPUT_VALUE)
    }
    if (spanKind === 'retrieval' && tags[OUTPUT_DOCUMENTS]) {
      meta.output.documents = JSON.stringify(this._pop(tags, OUTPUT_DOCUMENTS))
    }
    if (formattedSpan.error) {
      meta[ERROR_MESSAGE] = tags[ERROR_MESSAGE]
      meta[ERROR_TYPE] = tags[ERROR_TYPE]
      meta[ERROR_STACK] = tags[ERROR_STACK]
    }

    if (!meta.input) delete meta.input
    if (!meta.output) delete meta.output

    const metrics = JSON.parse(this._pop(tags, METRICS, '{}'))

    // TODO: remove when not walking up the trace anymore
    // this will be stitched together on the backend
    const mlApp = getMlApp(span, this._config.llmobs.mlApp)
    delete tags[ML_APP]
    const sessionId = getSessionId(span)
    delete tags[SESSION_ID]
    const parentId = getLLMObsParentId(span)
    delete tags[PARENT_ID_KEY]

    return {
      trace_id: span.context().toTraceId(true),
      span_id: span.context().toSpanId(),
      parent_id: parentId,
      session_id: sessionId,
      name: formattedSpan.name,
      tags: this._processTags(formattedSpan, mlApp, sessionId),
      start_ns: formattedSpan.start,
      duration: formattedSpan.duration,
      status: formattedSpan.error ? 'error' : 'ok',
      meta,
      metrics
    }
  }

  _processTags (span, mlApp, sessionId) {
    let tags = {
      version: this._config.version,
      env: this._config.env,
      service: this._config.service,
      source: 'integration',
      ml_app: mlApp,
      session_id: sessionId,
      'dd-trace.version': TRACER_VERSION,
      error: span.error
    }
    const errType = span.meta[ERROR_TYPE]
    if (errType) tags.error_type = errType
    const existingTags = this._pop(TAGS)
    if (existingTags) tags = { ...tags, ...existingTags }
    return Object.entries(tags).map(([key, value]) => `${key}:${value}`)
  }

  _pop (tags, key, defaultValue) {
    const value = tags[key]
    delete tags[key]
    return value || defaultValue
  }
}

module.exports = LLMObsSpanProcessor

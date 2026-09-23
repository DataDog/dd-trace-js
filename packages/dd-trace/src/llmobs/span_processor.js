'use strict'

const util = require('node:util')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')
const LLMObsExporter = require('../exporters/llmobs')
const {
  ERROR_MESSAGE,
  ERROR_TYPE,
  ERROR_STACK,
} = require('../constants')
const {
  SPAN_KIND,
  MODEL_NAME,
  MODEL_PROVIDER,
  METADATA,
  COST_TAGS,
  TOOL_DEFINITIONS,
  INPUT_MESSAGES,
  INPUT_VALUE,
  INTEGRATION,
  OUTPUT_MESSAGES,
  INPUT_DOCUMENTS,
  OUTPUT_DOCUMENTS,
  OUTPUT_VALUE,
  METRICS,
  ML_APP,
  TAGS,
  PARENT_ID_KEY,
  PARENT_AGENT_NAME,
  PARENT_AGENT_SPAN_ID,
  SESSION_ID,
  NAME,
  INPUT_PROMPT,
  ROUTING_API_KEY,
  ROUTING_SITE,
  LLMOBS_SUBMITTED_TAG_KEY,
  SAMPLE_RATE,
  SAMPLING_DECISION,
  TRACE_ID,
  LLMOBS_META_STRUCT_KEY,
} = require('./constants/tags')
const { UNSERIALIZABLE_VALUE_TEXT } = require('./constants/text')
const telemetry = require('./telemetry')
const LLMObsTagger = require('./tagger')

class LLMObservabilitySpan {
  /**
   * @param {string} kind span kind
   */
  constructor (kind) {
    this.input = []
    this.output = []

    /** @type {string} */
    this.kind = kind

    this._tags = {}
  }

  getTag (key) {
    return this._tags[key]
  }
}

class LLMObsSpanProcessor {
  /** @type {Map<object | string, object>} */
  #cachedEvents = new Map()

  #destroyer

  /** @type {import('../config/config-base')} */
  #config

  /** @type {((span: LLMObservabilitySpan) => LLMObservabilitySpan | null) | null} */
  #userSpanProcessor

  /** @type {import('./writers/spans')} */
  #writer

  constructor (config) {
    this.#config = config

    this.#destroyer = this.destroy.bind(this)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.#destroyer)
  }

  setUserSpanProcessor (userSpanProcessor) {
    this.#userSpanProcessor = userSpanProcessor
  }

  setWriter (writer) {
    this.#writer = writer
  }

  // TODO: instead of relying on the tagger's weakmap registry, can we use some namespaced storage correlation?
  process (span) {
    if (!this.#config.llmobs.DD_LLMOBS_ENABLED) return
    // if the span is not in our private tagger map, it is not an llmobs span
    if (!LLMObsTagger.tagMap.has(span)) return

    try {
      const formattedEvent = this.format(span)
      telemetry.incrementLLMObsSpanFinishedCount(span)
      if (formattedEvent == null) return

      const mlObsTags = LLMObsTagger.tagMap.get(span)
      const routing = {
        apiKey: mlObsTags[ROUTING_API_KEY],
        site: mlObsTags[ROUTING_SITE],
      }

      const metaStructTags = {
        mlApp: mlObsTags[ML_APP],
        sampleRate: mlObsTags[SAMPLE_RATE],
        samplingDecision: mlObsTags[SAMPLING_DECISION],
      }

      const trace = span.context()._trace
      const useApmIntake = span.tracer()._exporter instanceof LLMObsExporter
      if (!useApmIntake || this.#config.DD_TRACE_ENABLED === false || !trace || trace.record === false) {
        this.#appendToWriter(span, formattedEvent, routing)
      } else {
        this.#cachedEvents.set(this.#getCacheKey(span), { span, event: formattedEvent, metaStructTags, routing })
      }
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

  /**
   * Routes cached events once the APM processor has finalized whether the trace chunk can be exported.
   * @param {{
   *   spans: import('../opentracing/span')[],
   *   willExport: boolean,
   * }} trace
   */
  processTrace ({ spans, willExport }) {
    for (const span of spans) {
      const cacheKey = this.#getCacheKey(span)
      const cached = this.#cachedEvents.get(cacheKey)
      if (!cached) continue

      try {
        const { event, metaStructTags, routing } = cached
        if (this.#shouldAttachMetaStruct(routing, event, willExport)) {
          this.#attachMetaStruct(span, event, metaStructTags)
          this.#cachedEvents.delete(cacheKey)
        } else {
          this.#cachedEvents.delete(cacheKey)
          this.#appendToWriter(span, event, routing)
        }
      } catch {
        this.#cachedEvents.delete(cacheKey)
        try {
          this.#appendToWriter(span, cached.event, cached.routing)
        } catch (appendError) {
          this.#logAppendError(appendError)
        }
      }
    }
  }

  /** Routes events still awaiting an APM decision through the traditional LLMObs writer. */
  processPending () {
    for (const [cacheKey, cached] of this.#cachedEvents) {
      this.#cachedEvents.delete(cacheKey)

      try {
        this.#appendToWriter(cached.span, cached.event, cached.routing)
      } catch (error) {
        this.#logAppendError(error)
      }
    }
  }

  destroy () {
    if (!this.#destroyer) return

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(this.#destroyer)
    this.processPending()
    this.#destroyer = undefined
  }

  format (span) {
    let inputType, outputType

    const spanTags = span.context().getTags()
    const mlObsTags = LLMObsTagger.tagMap.get(span)

    const spanKind = mlObsTags[SPAN_KIND]

    const meta = { 'span.kind': spanKind, input: {}, output: {} }
    const input = {}
    const output = {}

    if (['llm', 'embedding'].includes(spanKind)) {
      meta.model_name = mlObsTags[MODEL_NAME] || 'custom'
      meta.model_provider = (mlObsTags[MODEL_PROVIDER] || 'custom').toLowerCase()
    }

    if (mlObsTags[METADATA] || mlObsTags[COST_TAGS]) {
      const metadata = {}
      if (mlObsTags[METADATA]) this.#addObject(mlObsTags[METADATA], metadata)
      // Only seed `metadata._dd` when there's something to put in it (currently cost_tags). Mirrors
      // dd-trace-py and the cross-language wire format enforced by system-tests — metadata-only
      // spans must not carry an empty `_dd: {}` block.
      if (mlObsTags[COST_TAGS]) {
        this.#getDdMetadata(metadata).cost_tags = mlObsTags[COST_TAGS]
      }
      meta.metadata = metadata
    }

    if (mlObsTags[TOOL_DEFINITIONS]) {
      meta.tool_definitions = []
      this.#addObject(mlObsTags[TOOL_DEFINITIONS], meta.tool_definitions)
    }

    // Surface the agent attribution resolved at registration, but only on spans that actually
    // have an agent ancestor. The id is always present in that case; the name may be missing when
    // it arrived id-only over distributed propagation (older/unsafe upstream). Emit the name as
    // explicit `null` then, matching the cross-language wire shape (dd-trace-py sends null, not an
    // absent key) so the shared backend and system-tests see the same payload.
    const parentAgentName = mlObsTags[PARENT_AGENT_NAME]
    const parentAgentSpanId = mlObsTags[PARENT_AGENT_SPAN_ID]
    if (parentAgentName != null || parentAgentSpanId != null) {
      meta.agent_attribution = {
        pagent_name: parentAgentName ?? null,
        pagent_span_id: parentAgentSpanId,
      }
    }

    const llmObsSpan = new LLMObservabilitySpan(spanKind)

    if (spanKind === 'llm' && mlObsTags[INPUT_MESSAGES]) {
      llmObsSpan.input = mlObsTags[INPUT_MESSAGES]
      inputType = 'messages'
    } else if (spanKind === 'embedding' && mlObsTags[INPUT_DOCUMENTS]) {
      llmObsSpan.input = mlObsTags[INPUT_DOCUMENTS].map(doc => ({ content: doc.text, role: '' }))
      inputType = 'documents'
    } else if (mlObsTags[INPUT_VALUE]) {
      llmObsSpan.input = [{ role: '', content: mlObsTags[INPUT_VALUE] }]
      inputType = 'value'
    }

    if (spanKind === 'llm' && mlObsTags[OUTPUT_MESSAGES]) {
      llmObsSpan.output = mlObsTags[OUTPUT_MESSAGES]
      outputType = 'messages'
    } else if (spanKind === 'retrieval' && mlObsTags[OUTPUT_DOCUMENTS]) {
      llmObsSpan.output = mlObsTags[OUTPUT_DOCUMENTS].map(doc => ({ content: doc.text, role: '' }))
      outputType = 'documents'
    } else if (mlObsTags[OUTPUT_VALUE]) {
      llmObsSpan.output = [{ role: '', content: mlObsTags[OUTPUT_VALUE] }]
      outputType = 'value'
    }

    const error = spanTags.error || spanTags[ERROR_TYPE]
    if (error) {
      meta[ERROR_MESSAGE] = spanTags[ERROR_MESSAGE] || error.message || error.code
      meta[ERROR_TYPE] = spanTags[ERROR_TYPE] || error.name
      meta[ERROR_STACK] = spanTags[ERROR_STACK] || error.stack
    }

    const metrics = mlObsTags[METRICS] || {}

    const mlApp = mlObsTags[ML_APP]
    const sessionId = mlObsTags[SESSION_ID]
    const parentId = mlObsTags[PARENT_ID_KEY]

    const name = mlObsTags[NAME] || span._name

    const tags = this.#getTags(span, mlApp, sessionId, error)
    llmObsSpan._tags = tags

    const processedSpan = this.#runProcessor(llmObsSpan)
    if (processedSpan === undefined) return null

    if (processedSpan.input) {
      if (inputType === 'messages') {
        input.messages = processedSpan.input
      } else if (inputType === 'value') {
        input.value = processedSpan.input[0].content
      } else if (inputType === 'documents') {
        input.documents = processedSpan.input.map((processedDocument, processedDocumentIdx) => ({
          ...mlObsTags[INPUT_DOCUMENTS][processedDocumentIdx],
          text: processedDocument.content,
        }))
      }
    }

    if (processedSpan.output) {
      if (outputType === 'messages') {
        output.messages = processedSpan.output
      } else if (outputType === 'value') {
        output.value = processedSpan.output[0].content
      } else if (outputType === 'documents') {
        output.documents = processedSpan.output.map((processedDocument, processedDocumentIdx) => ({
          ...mlObsTags[OUTPUT_DOCUMENTS][processedDocumentIdx],
          text: processedDocument.content,
        }))
      }
    }

    if (input) meta.input = input
    if (output) meta.output = output

    const prompt = mlObsTags[INPUT_PROMPT]
    if (prompt && spanKind === 'llm') {
      // by this point, we should have logged a warning if the span kind was not llm
      meta.input.prompt = prompt
    }

    const apmTraceId = span.context().toTraceId(true)
    const llmobsTraceId = mlObsTags[TRACE_ID] ?? apmTraceId
    const dd = {
      span_id: span.context().toSpanId(),
      trace_id: apmTraceId,
      sample_rate: mlObsTags[SAMPLE_RATE],
      sampling_decision: mlObsTags[SAMPLING_DECISION],
      apm_trace_id: apmTraceId,
    }
    if (tags.experiment_id) dd.scope = 'experiments'

    const llmObsSpanEvent = {
      trace_id: llmobsTraceId,
      span_id: span.context().toSpanId(),
      parent_id: parentId,
      name,
      tags: this.#objectTagsToStringArrayTags(tags),
      start_ns: Math.round(span._startTime * 1e6),
      duration: Math.round(span._duration * 1e6),
      status: error ? 'error' : 'ok',
      meta,
      metrics,
      _dd: dd,
    }

    if (sessionId) llmObsSpanEvent.session_id = sessionId

    return llmObsSpanEvent
  }

  /**
   * @param {{ apiKey?: string, site?: string }} routing
   * @param {object} event
   * @param {boolean} willExport
   */
  #shouldAttachMetaStruct (routing, event, willExport) {
    return willExport &&
      !routing.apiKey &&
      !routing.site &&
      !this.#hasRepeatedTagKeys(event.tags)
  }

  /** @param {import('../opentracing/span') | object} span */
  #getCacheKey (span) {
    const context = span.context?.()
    return context?._spanId ?? context?.toSpanId() ?? span.span_id
  }

  /**
   * @param {import('../opentracing/span')} span
   * @param {object} event
   * @param {{ apiKey?: string, site?: string }} routing
   */
  #appendToWriter (span, event, routing) {
    const enqueued = this.#writer.append(event, routing)
    if (enqueued) span.context().setTag(LLMOBS_SUBMITTED_TAG_KEY, '1')
  }

  /** @param {Error} error */
  #logAppendError (error) {
    logger.warn(`
      Failed to append span to LLM Observability writer, likely due to an unserializable property.
      Span won't be sent to LLM Observability: ${error.message}
    `)
  }

  /**
   * The meta_struct tag map cannot losslessly represent repeated tag keys.
   * @param {string[]} tags
   */
  #hasRepeatedTagKeys (tags) {
    const keys = new Set()
    for (const tag of tags) {
      const separatorIndex = tag.indexOf(':')
      if (separatorIndex === -1) continue

      const key = tag.slice(0, separatorIndex)
      if (keys.has(key)) return true
      keys.add(key)
    }
    return false
  }

  /**
   * @param {import('../opentracing/span')} span
   * @param {object} event
   * @param {{ mlApp?: string, sampleRate?: string, samplingDecision?: string }} metaStructTags
   */
  #attachMetaStruct (span, event, metaStructTags) {
    span.meta_struct ??= {}
    span.meta_struct[LLMOBS_META_STRUCT_KEY] = this.#formatMetaStruct(event, metaStructTags)
  }

  /**
   * @param {object} event
   * @param {{ mlApp?: string, sampleRate?: string, samplingDecision?: string }} metaStructTags
   */
  #formatMetaStruct (event, metaStructTags) {
    const dd = {}
    if (metaStructTags.sampleRate !== undefined) dd.sample_rate = metaStructTags.sampleRate
    if (metaStructTags.samplingDecision !== undefined) dd.sampling_decision = metaStructTags.samplingDecision
    if (event._dd?.scope !== undefined) dd.scope = event._dd.scope

    const metaStruct = {
      trace_id: event.trace_id,
      tags: this.#stringArrayTagsToObjectTags(event.tags),
      meta: this.#formatMetaStructMeta(event.meta),
      metrics: event.metrics,
      _dd: dd,
    }

    if (event.parent_id !== undefined) metaStruct.parent_id = event.parent_id
    if (event.name !== undefined) metaStruct.name = event.name
    if (metaStructTags.mlApp) metaStruct.ml_app = metaStructTags.mlApp
    if (event.session_id) metaStruct.session_id = event.session_id

    return metaStruct
  }

  /** @param {object} eventMeta */
  #formatMetaStructMeta (eventMeta) {
    const meta = {}

    for (const [key, value] of Object.entries(eventMeta)) {
      if (key === 'span.kind') {
        meta.span = { kind: value }
      } else if (key === ERROR_MESSAGE) {
        this.#getMetaStructError(meta).message = value
      } else if (key === ERROR_TYPE) {
        this.#getMetaStructError(meta).type = value
      } else if (key === ERROR_STACK) {
        this.#getMetaStructError(meta).stack = value
      } else {
        meta[key] = value
      }
    }

    return meta
  }

  /** @param {object} meta */
  #getMetaStructError (meta) {
    if (!meta.error) meta.error = {}
    return meta.error
  }

  // For now, this only applies to metadata, as we let users annotate this field with any object
  // However, we want to protect against circular references or BigInts (unserializable)
  // This function can be reused for other fields if needed
  // Messages, Documents, and Metrics are safeguarded in `llmobs/tagger.js`
  #addObject (obj, carrier) {
    // Capture root object by default
    const seenObjects = new WeakSet([obj])

    const isCircular = value => {
      if (value == null || typeof value !== 'object') return false
      if (seenObjects.has(value)) return true
      seenObjects.add(value)
      return false
    }

    const add = (obj, carrier) => {
      for (const key in obj) {
        const value = obj[key]
        if (!Object.hasOwn(obj, key)) continue
        if (typeof value === 'bigint' || isCircular(value)) {
          // mark as unserializable instead of dropping
          logger.warn(`Unserializable property found in metadata: ${key}`)
          carrier[key] = UNSERIALIZABLE_VALUE_TEXT
          continue
        }
        if (value !== null && typeof value === 'object') {
          carrier[key] = Array.isArray(value) ? [] : {}
          add(value, carrier[key])
        } else {
          carrier[key] = value
        }
      }
    }

    add(obj, carrier)
  }

  /**
   * Returns `metadata._dd`, normalizing it to a fresh object if missing or invalid.
   * @param {Record<string, unknown>} metadata
   * @returns {Record<string, unknown>}
   */
  #getDdMetadata (metadata) {
    if (!metadata._dd || typeof metadata._dd !== 'object' || Array.isArray(metadata._dd)) {
      metadata._dd = {}
    }
    return metadata._dd
  }

  #getTags (span, mlApp, sessionId, error) {
    let tags = {
      ...this.#config.parsedDdTags,
      version: this.#config.version,
      env: this.#config.env,
      service: this.#config.service,
      source: 'integration',
      ml_app: mlApp,
      'ddtrace.version': tracerVersion,
      error: Number(!!error) || 0,
      language: 'javascript',
    }

    const errType = span.context().getTag(ERROR_TYPE) || error?.name
    if (errType) tags.error_type = errType

    if (sessionId) tags.session_id = sessionId

    const integration = LLMObsTagger.tagMap.get(span)?.[INTEGRATION]
    if (integration) tags.integration = integration

    const existingTags = LLMObsTagger.tagMap.get(span)?.[TAGS] || {}
    if (existingTags) tags = { ...tags, ...existingTags }

    return tags
  }

  /**
   * @param {Record<string, unknown>} tags
   */
  #objectTagsToStringArrayTags (tags) {
    const out = []
    for (const [key, value] of Object.entries(tags)) {
      // Comma is the intake-side tag delimiter, so a single `"key:v1,v2"`
      // entry fans into two orphan tags. One-per-element keeps each value
      // addressable; empty arrays fall through to the scalar branch and
      // still emit `key:` so `_dd.cost_tags` references keep finding a
      // wire entry.
      if (Array.isArray(value) && value.length > 0) {
        for (const item of value) out.push(`${key}:${item ?? ''}`)
      } else {
        out.push(`${key}:${value ?? ''}`)
      }
    }
    return out
  }

  /**
   * @param {string[]} tags
   * @returns {Record<string, string>}
   */
  #stringArrayTagsToObjectTags (tags) {
    const out = {}
    for (const tag of tags) {
      const separatorIndex = tag.indexOf(':')
      if (separatorIndex === -1) continue

      out[tag.slice(0, separatorIndex)] = tag.slice(separatorIndex + 1)
    }
    return out
  }

  /**
   * Runs the user span processor, emitting telemetry and adding some guardrails against invalid return types
   * @param {LLMObservabilitySpan} span
   * @returns {LLMObservabilitySpan | undefined}
   */
  #runProcessor (span) {
    const processor = this.#userSpanProcessor
    if (!processor) return span

    let error = false

    try {
      const processedLLMObsSpan = processor(span)
      if (processedLLMObsSpan === null) return

      if (!(processedLLMObsSpan instanceof LLMObservabilitySpan)) {
        error = true
        logger.warn('User span processor must return an instance of an LLMObservabilitySpan or null, dropping span.')
        return
      }

      return processedLLMObsSpan
    } catch (e) {
      logger.error(`[LLMObs] Error in LLMObs span processor (${util.inspect(processor)}): ${util.inspect(e)}`)
      error = true
    } finally {
      telemetry.recordLLMObsUserProcessorCalled(error)
    }
  }
}

module.exports = LLMObsSpanProcessor

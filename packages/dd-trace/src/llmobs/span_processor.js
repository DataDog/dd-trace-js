'use strict'

const util = require('node:util')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')
const {
  ERROR_MESSAGE,
  ERROR_TYPE,
  ERROR_STACK,
} = require('../constants')
const { AUTO_REJECT } = require('../../../../ext/priority')
const {
  CACHED_LLMOBS_EVENT_SYMBOL,
  LLMOBS_META_STRUCT_KEY,
  LLMObsExportMode,
  getLLMObsExportMode,
  getLLMObsWriterExportMode,
  isLLMObsWriterExportMode,
} = require('./export-mode')
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
  SESSION_ID,
  NAME,
  INPUT_PROMPT,
  ROUTING_API_KEY,
  ROUTING_SITE,
  LLMOBS_SUBMITTED_TAG_KEY,
  SAMPLE_RATE,
  SAMPLING_DECISION,
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
  /** @type {import('../config/config-base')} */
  #config

  /** @type {((span: LLMObservabilitySpan) => LLMObservabilitySpan | null) | null} */
  #userSpanProcessor

  /** @type {import('./writers/spans')} */
  #writer

  constructor (config) {
    this.#config = config
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
      const mode = this.#getSpanExportMode(routing)

      if (mode === LLMObsExportMode.APM_AGENT || mode === LLMObsExportMode.APM_AGENTLESS) {
        span.meta_struct ??= {}
        span.meta_struct[LLMOBS_META_STRUCT_KEY] = this.#formatMetaStruct(formattedEvent, mlObsTags, mode)
        if (mode === LLMObsExportMode.APM_AGENT) {
          span[CACHED_LLMOBS_EVENT_SYMBOL] = {
            event: formattedEvent,
            routing,
          }
        }
        return
      }

      if (!isLLMObsWriterExportMode(mode)) return

      const enqueued = this.#writer.append(formattedEvent, routing)

      // Marker read by the dd-go LLMObs trace-indexer: when reparenting OTel
      // gen_ai.* spans, the parent-chain walk stops at any span carrying this
      // tag, preserving this span as the immediate LLMObs parent. Set only
      // when the writer actually buffered the event — format may have dropped
      // it (user processor returned null), thrown, or the writer may have
      // dropped it silently when its buffer is full. Leaving this tag off in
      // those cases avoids dd-go reparenting OTel children under a span that
      // has no corresponding LLMObs event.
      if (enqueued) {
        span.context().setTag(LLMOBS_SUBMITTED_TAG_KEY, '1')
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
   * Resubmits cached LLMObs events when the local APM agent path will drop the trace.
   *
   * @param {Array<import('../opentracing/span')>} spans
   * @returns {void}
   */
  processSampledTrace (spans) {
    if (!this.#config.llmobs.DD_LLMOBS_ENABLED ||
        !this.#writer ||
        getLLMObsExportMode(this.#config, this.#writer) !== LLMObsExportMode.APM_AGENT) {
      return
    }

    const samplingPriority = spans[0]?.context()?._sampling?.priority
    if (samplingPriority === undefined || samplingPriority > AUTO_REJECT) return

    for (const span of spans) {
      if (span._duration === undefined) continue
      if (!span.meta_struct?.[LLMOBS_META_STRUCT_KEY]) continue

      const cached = span[CACHED_LLMOBS_EVENT_SYMBOL]
      if (!cached) {
        this.#scrubLLMObsMetaStruct(span)
        continue
      }

      try {
        const enqueued = this.#writer.append(cached.event, cached.routing)
        if (enqueued) {
          span.context().setTag(LLMOBS_SUBMITTED_TAG_KEY, '1')
        }
      } catch (error) {
        logger.warn(
          'Failed to rescue LLM Observability span event from a sampled-out APM trace: %s',
          error.message
        )
      } finally {
        this.#scrubLLMObsMetaStruct(span)
      }
    }
  }

  /**
   * Removes the LLMObs event from APM trace metadata without disturbing other structured metadata.
   *
   * @param {import('../opentracing/span')} span
   * @returns {void}
   */
  #scrubLLMObsMetaStruct (span) {
    const metaStruct = span.meta_struct
    if (!metaStruct) return

    let hasOtherStructuredMetadata = false
    for (const key of Object.keys(metaStruct)) {
      if (key !== LLMOBS_META_STRUCT_KEY) {
        hasOtherStructuredMetadata = true
        break
      }
    }

    delete metaStruct[LLMOBS_META_STRUCT_KEY]
    if (!hasOtherStructuredMetadata) {
      span.meta_struct = undefined
    }
  }

  /**
   * Formats the compact LLMObs struct that rides inside APM span meta_struct.
   * This mirrors dd-trace-py's `_llmobs` struct; the full LLMObs span event is
   * only used for direct writer submission and fallback rescue.
   *
   * @param {object} event
   * @param {Record<string, unknown>} mlObsTags
   * @param {string} mode
   * @returns {object}
   */
  #formatMetaStruct (event, mlObsTags, mode) {
    const dd = {}
    if (mlObsTags[SAMPLE_RATE] !== undefined) dd.sample_rate = mlObsTags[SAMPLE_RATE]
    if (mlObsTags[SAMPLING_DECISION] !== undefined) dd.sampling_decision = mlObsTags[SAMPLING_DECISION]

    const metaStruct = {
      trace_id: event.trace_id,
      meta: this.#formatMetaStructMeta(event.meta),
      metrics: event.metrics,
      tags: this.#formatMetaStructTags(this.#getTagsObject(event.tags), mode),
      _dd: dd,
    }

    if (event.parent_id !== undefined) metaStruct.parent_id = event.parent_id
    if (event.name !== undefined) metaStruct.name = event.name
    if (mlObsTags[ML_APP]) metaStruct.ml_app = mlObsTags[ML_APP]
    if (event.session_id) metaStruct.session_id = event.session_id

    return metaStruct
  }

  /**
   * Converts the JS writer event meta shape to the LLMObs meta_struct shape.
   *
   * @param {object} eventMeta
   * @returns {object}
   */
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

  /**
   * Returns `meta.error`, initializing it once.
   *
   * @param {object} meta
   * @returns {object}
   */
  #getMetaStructError (meta) {
    if (!meta.error) meta.error = {}
    return meta.error
  }

  /**
   * Converts writer tags back to the Python meta_struct tag map.
   *
   * @param {string[]} tags
   * @returns {Record<string, string>}
   */
  #getTagsObject (tags) {
    const tagsObject = {}

    for (const tag of tags) {
      const separator = tag.indexOf(':')
      if (separator === -1) continue
      tagsObject[tag.slice(0, separator)] = tag.slice(separator + 1)
    }

    return tagsObject
  }

  /**
   * Normalizes tag keys for the APM agentless intake.
   *
   * @param {Record<string, string>} tags
   * @param {string} mode
   * @returns {Record<string, string>}
   */
  #formatMetaStructTags (tags, mode) {
    if (mode !== LLMObsExportMode.APM_AGENTLESS) return tags

    const normalizedTags = {}
    for (const [key, value] of Object.entries(tags)) {
      normalizedTags[key.replaceAll('.', '_')] = value
    }
    return normalizedTags
  }

  /**
   * Returns the export mode for this span. Per-span LLMObs routing requires
   * the direct writer because an APM trace cannot carry an alternate API key.
   *
   * @param {{ apiKey: string | undefined, site: string | undefined }} routing
   * @returns {string}
   */
  #getSpanExportMode (routing) {
    if (routing.apiKey) return getLLMObsWriterExportMode(this.#config, this.#writer)

    return getLLMObsExportMode(this.#config, this.#writer)
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

    const llmObsSpanEvent = {
      trace_id: span.context().toTraceId(true),
      span_id: span.context().toSpanId(),
      parent_id: parentId,
      name,
      tags: this.#objectTagsToStringArrayTags(tags),
      start_ns: Math.round(span._startTime * 1e6),
      duration: Math.round(span._duration * 1e6),
      status: error ? 'error' : 'ok',
      meta,
      metrics,
      _dd: {
        span_id: span.context().toSpanId(),
        trace_id: span.context().toTraceId(true),
        sample_rate: mlObsTags[SAMPLE_RATE],
        sampling_decision: mlObsTags[SAMPLING_DECISION],
      },
    }

    if (sessionId) llmObsSpanEvent.session_id = sessionId

    return llmObsSpanEvent
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

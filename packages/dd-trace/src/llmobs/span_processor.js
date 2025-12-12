'use strict'

const {
  SPAN_KIND,
  MODEL_NAME,
  MODEL_PROVIDER,
  METADATA,
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
  NAME
} = require('./constants/tags')
const { UNSERIALIZABLE_VALUE_TEXT } = require('./constants/text')

const {
  ERROR_MESSAGE,
  ERROR_TYPE,
  ERROR_STACK
} = require('../constants')

const telemetry = require('./telemetry')

const LLMObsTagger = require('./tagger')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')

const util = require('node:util')

class LLMObservabilitySpan {
  constructor () {
    this.input = []
    this.output = []

    this._tags = {}
  }

  getTag (key) {
    return this._tags[key]
  }
}

class LLMObsSpanProcessor {
  /** @type {import('../config')} */
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
    if (!this.#config.llmobs.enabled) return
    // if the span is not in our private tagger map, it is not an llmobs span
    if (!LLMObsTagger.tagMap.has(span)) return

    try {
      const formattedEvent = this.format(span)
      telemetry.incrementLLMObsSpanFinishedCount(span)
      if (formattedEvent == null) return

      this.#writer.append(formattedEvent)
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
    const llmObsSpan = new LLMObservabilitySpan()
    let inputType, outputType

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
      this.#addObject(mlObsTags[METADATA], meta.metadata = {})
    }

    if (spanKind === 'llm' && mlObsTags[INPUT_MESSAGES]) {
      llmObsSpan.input = mlObsTags[INPUT_MESSAGES]
      inputType = 'messages'
    } else if (spanKind === 'embedding' && mlObsTags[INPUT_DOCUMENTS]) {
      input.documents = mlObsTags[INPUT_DOCUMENTS]
    } else if (mlObsTags[INPUT_VALUE]) {
      llmObsSpan.input = [{ role: '', content: mlObsTags[INPUT_VALUE] }]
      inputType = 'value'
    }

    // Handle prompt metadata for reusable prompts
    if (mlObsTags['_ml_obs.meta.input.prompt']) {
      input.prompt = mlObsTags['_ml_obs.meta.input.prompt']
    }
    const promptTrackingAuto = mlObsTags['_ml_obs._dd.prompt_tracking_auto']

    if (spanKind === 'llm' && mlObsTags[OUTPUT_MESSAGES]) {
      llmObsSpan.output = mlObsTags[OUTPUT_MESSAGES]
      outputType = 'messages'
    } else if (spanKind === 'retrieval' && mlObsTags[OUTPUT_DOCUMENTS]) {
      output.documents = mlObsTags[OUTPUT_DOCUMENTS]
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
      }
    }

    if (processedSpan.output) {
      if (outputType === 'messages') {
        output.messages = processedSpan.output
      } else if (outputType === 'value') {
        output.value = processedSpan.output[0].content
      }
    }

    if (input) meta.input = input
    if (output) meta.output = output

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
        trace_id: span.context().toTraceId(true)
      }
    }

    if (!input.prompt && spanKind === 'llm' && mlObsTags[INTEGRATION] === 'langchain') {
      const ancestorVars = getLangChainPromptVariablesFromAncestors(span)
      if (ancestorVars) {
        const { prompt, didReplace } = buildPromptFromInputMessages(input.messages, ancestorVars)
        if (didReplace) {
          input.prompt = prompt
          llmObsSpanEvent._dd.prompt_tracking_auto = 1
        }
      }
    }

    if (promptTrackingAuto) llmObsSpanEvent._dd.prompt_tracking_auto = 1
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
      language: 'javascript'
    }

    const errType = span.context()._tags[ERROR_TYPE] || error?.name
    if (errType) tags.error_type = errType

    if (sessionId) tags.session_id = sessionId

    const integration = LLMObsTagger.tagMap.get(span)?.[INTEGRATION]
    if (integration) tags.integration = integration

    const existingTags = LLMObsTagger.tagMap.get(span)?.[TAGS] || {}
    if (existingTags) tags = { ...tags, ...existingTags }

    return tags
  }

  #objectTagsToStringArrayTags (tags) {
    return Object.entries(tags).map(([key, value]) => `${key}:${value ?? ''}`)
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

function getLangChainPromptVariablesFromAncestors (span) {
  let current = span._parent
  while (current) {
    const parentTags = LLMObsTagger.tagMap.get(current)
    if (
      parentTags?.[INTEGRATION] === 'langchain' &&
      parentTags?.[SPAN_KIND] === 'workflow' &&
      parentTags?.[INPUT_VALUE]
    ) {
      const raw = parentTags[INPUT_VALUE]
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
        } catch {}
      }
    }
    current = current._parent
  }
  return null
}

function buildPromptFromInputMessages (inputMessages, variables) {
  if (!Array.isArray(inputMessages)) return { prompt: null, didReplace: false }

  const normalized = {}
  for (const [k, v] of Object.entries(variables)) {
    if (v == null) continue
    normalized[k] = typeof v === 'string' ? v : String(v)
  }

  const values = Object.entries(normalized)
    .filter(([, v]) => v.length > 0)
    .sort((a, b) => b[1].length - a[1].length)

  let didReplace = false
  const chatTemplate = inputMessages.map(m => {
    const role = m?.role ?? ''
    let content = m?.content ?? ''
    for (const [name, val] of values) {
      const next = content.split(val).join(`{{${name}}}`)
      if (next !== content) didReplace = true
      content = next
    }
    return { role, content }
  })

  return {
    prompt: { id: 'langchain.prompt_template', variables: normalized, chat_template: chatTemplate },
    didReplace
  }
}

module.exports = LLMObsSpanProcessor

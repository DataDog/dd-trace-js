'use strict'

const { channel } = require('dc-polyfill')

const { isError } = require('../util')
const logger = require('../log')
const { getValueFromEnvSources } = require('../config/helper')
const Span = require('../opentracing/span')
const {
  SPAN_KIND,
  OUTPUT_VALUE,
  INPUT_VALUE,
  TRACE_ID,
} = require('./constants/tags')
const {
  FEEDBACK_METRIC_TYPES,
  FEEDBACK_TARGET_KEYS,
  buildMetricTags,
  validateAssessment,
  validateLabel,
  validateMetricType,
  validateMetricValue,
  validateReasoning,
  validateTimestamp,
} = require('./eval-metric')
const {
  getFunctionArguments,
  validateKind,
} = require('./util')
const { storage } = require('./storage')
const telemetry = require('./telemetry')
const LLMObsTagger = require('./tagger')
const { createExperiments } = require('./experiments')

// communicating with writer
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const registerUserSpanProcessorCh = channel('llmobs:register-processor')
const NoopLLMObs = require('./noop')

class LLMObs extends NoopLLMObs {
  /**
   * flag representing if a user span processor has been registered
   * @type {boolean}
   */
  #hasUserSpanProcessor = false

  /**
   * @param {import('../tracer')} tracer - Tracer instance
   * @param {import('./index')} llmobsModule - LLMObs module instance
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  constructor (tracer, llmobsModule, config) {
    super(tracer)

    /** @type {import('../config/config-base')} */
    this._config = config

    this._llmobsModule = llmobsModule
    this._tagger = new LLMObsTagger(config)
  }

  get enabled () {
    return this._config.llmobs.DD_LLMOBS_ENABLED ?? false
  }

  /**
   * Datasets & Experiments API. Requires LLM Observability to be enabled and
   * DD_API_KEY / DD_APP_KEY to be set; otherwise the returned facade throws with
   * a clear message on use.
   */
  get experiments () {
    return createExperiments(this._config, this)
  }

  enable (options = {}) {
    logger.warn(
      'Enabling LLM Observability via `llmobs.enable()` is deprecated and will be removed in dd-trace@7.0.0. ' +
      'Please instantiate LLM Observability via DD_LLMOBS_ENABLED or `tracer.init({ llmobs: ...options })`.'
    )

    if (this.enabled) {
      logger.debug('LLMObs is already enabled.')
      return
    }

    logger.debug('Enabling LLMObs')

    // skipDefault: only an explicit DD_LLMOBS_ENABLED=false blocks enable(); an unset value
    // (its default is false) must still allow this programmatic opt-in.
    const DD_LLMOBS_ENABLED = getValueFromEnvSources('DD_LLMOBS_ENABLED', true)

    if (DD_LLMOBS_ENABLED === false) {
      logger.debug('LLMObs.enable() called when DD_LLMOBS_ENABLED is false. No action taken.')
      return
    }

    // TODO: These configs should be passed through directly at construction time instead.
    this._config.llmobs.DD_LLMOBS_ENABLED = true
    this._config.llmobs.mlApp = options.mlApp
    this._config.llmobs.agentlessEnabled = options.agentlessEnabled

    // configure writers and channel subscribers
    this._llmobsModule.enable(this._config)
  }

  disable () {
    logger.warn(
      'Disabling LLM Observability via `llmobs.disable()` is deprecated and will be removed in dd-trace@7.0.0. ' +
      'Set DD_LLMOBS_ENABLED=false to disable LLM Observability.'
    )

    if (!this.enabled) {
      logger.debug('LLMObs is already disabled.')
      return
    }

    logger.debug('Disabling LLMObs')

    this._config.llmobs.DD_LLMOBS_ENABLED = false

    // disable writers and channel subscribers
    this._llmobsModule.disable()
  }

  trace (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const kind = validateKind(options.kind) // will throw if kind is undefined or not an expected kind

    telemetry.incrementLLMObsSpanStartCount({ autoinstrumented: false, kind })

    // name is required for spans generated with `trace`
    // while `kind` is required, this should never throw (as otherwise it would have thrown above)
    const name = options.name || kind
    if (!name) {
      throw new Error('No span name provided for `trace`.')
    }

    const {
      spanOptions,
      ...llmobsOptions
    } = this.#extractOptions(options, kind)

    if (fn.length > 1) {
      return this._tracer.trace(name, spanOptions, (span, cb) =>
        this.#activate(span, { kind, ...llmobsOptions }, () => fn(span, cb))
      )
    }

    return this._tracer.trace(name, spanOptions, span =>
      this.#activate(span, { kind, ...llmobsOptions }, () => fn(span))
    )
  }

  wrap (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const kind = validateKind(options.kind) // will throw if kind is undefined or not an expected kind
    let name = options.name || fn?.name || kind

    if (!name) {
      logger.warn('No span name provided for `wrap`. Defaulting to "unnamed-anonymous-function".')
      name = 'unnamed-anonymous-function'
    }

    const {
      spanOptions,
      ...llmobsOptions
    } = this.#extractOptions(options, kind)

    const llmobs = this

    function wrapped (...args) {
      telemetry.incrementLLMObsSpanStartCount({ autoinstrumented: false, kind })

      const span = llmobs._tracer.scope().active()
      const fnArgs = args

      const lastArgId = fnArgs.length - 1
      const cb = fnArgs[lastArgId]
      const hasCallback = typeof cb === 'function'

      if (hasCallback) {
        const scopeBoundCb = llmobs.#bind(cb)
        fnArgs[lastArgId] = function (...args) {
          // it is standard practice to follow the callback signature (err, result)
          // however, we try to parse the arguments to determine if the first argument is an error
          // if it is not, and is not undefined, we will use that for the output value
          const maybeError = args[0]
          const maybeResult = args[1]

          llmobs.#autoAnnotate(
            span,
            kind,
            getFunctionArguments(fn, fnArgs),
            isError(maybeError) || maybeError == null ? maybeResult : maybeError
          )

          return scopeBoundCb.apply(this, args)
        }
      }

      try {
        const result = llmobs.#activate(span, { kind, ...llmobsOptions }, () => fn.apply(this, fnArgs))

        if (result && typeof result.then === 'function') {
          return result.then(
            value => {
              if (!hasCallback) {
                llmobs.#autoAnnotate(span, kind, getFunctionArguments(fn, fnArgs), value)
              }
              return value
            },
            err => {
              llmobs.#autoAnnotate(span, kind, getFunctionArguments(fn, fnArgs))
              throw err
            }
          )
        }

        // it is possible to return a value and have a callback
        // however, since the span finishes when the callback is called, it is possible that
        // the callback is called before the function returns (although unlikely)
        // we do not want to throw for "annotating a finished span" in this case
        if (!hasCallback) {
          llmobs.#autoAnnotate(span, kind, getFunctionArguments(fn, fnArgs), result)
        }

        return result
      } catch (e) {
        llmobs.#autoAnnotate(span, kind, getFunctionArguments(fn, fnArgs))
        throw e
      }
    }

    return this._tracer.wrap(name, spanOptions, wrapped)
  }

  annotate (span, options, autoinstrumented = false) {
    if (!this.enabled) return

    if (!span) {
      span = this._active()
    }

    if ((span && !options) && !(span instanceof Span)) {
      options = span
      span = this._active()
    }

    let err = ''

    try {
      if (!span) {
        err = 'invalid_span_no_active_spans'
        throw new Error('No span provided and no active LLMObs-generated span found')
      }
      if (!options) {
        err = 'invalid_options'
        throw new Error('No options provided for annotation.')
      }

      if (!LLMObsTagger.tagMap.has(span)) {
        err = 'invalid_span_type'
        throw new Error('Span must be an LLMObs-generated span')
      }
      if (span._duration !== undefined) {
        err = 'invalid_finished_span'
        throw new Error('Cannot annotate a finished span')
      }

      const spanKind = LLMObsTagger.tagMap.get(span)[SPAN_KIND]
      if (!spanKind) {
        err = 'invalid_no_span_kind'
        throw new Error('LLMObs span must have a span kind specified')
      }

      const { inputData, outputData, metadata, metrics, tags, prompt, costTags, toolDefinitions, agent } = options

      if (inputData || outputData) {
        if (spanKind === 'llm') {
          this._tagger.tagLLMIO(span, inputData, outputData)
        } else if (spanKind === 'embedding') {
          this._tagger.tagEmbeddingIO(span, inputData, outputData)
        } else if (spanKind === 'retrieval') {
          this._tagger.tagRetrievalIO(span, inputData, outputData)
        } else {
          this._tagger.tagTextIO(span, inputData, outputData)
        }
      }

      if (metadata) {
        this._tagger.tagMetadata(span, metadata)
      }
      if (metrics) {
        this._tagger.tagMetrics(span, metrics)
      }
      // Apply tags before costTags so costTags can reference tags from the same annotation.
      if (tags) {
        this._tagger.tagSpanTags(span, tags)
      }
      if (costTags != null) {
        this._tagger.tagCostTags(span, costTags, 'annotate')
      }
      if (prompt) {
        this._tagger.tagPrompt(span, prompt)
      }
      if (toolDefinitions != null) {
        this._tagger.tagToolDefinitions(span, toolDefinitions)
      }
      if (agent?.version != null) {
        this._tagger.tagAgentVersion(span, agent.version)
      }
    } catch (e) {
      if (e.ddErrorTag) {
        err = e.ddErrorTag
      }
      throw e
    } finally {
      if (!autoinstrumented) {
        telemetry.recordLLMObsAnnotate(span, err)
      }
    }
  }

  exportSpan (span) {
    span ||= this._active()
    let err = ''
    try {
      if (!span) {
        err = 'no_active_span'
        throw new Error('No span provided and no active LLMObs-generated span found')
      }
      if (!(span instanceof Span)) {
        err = 'invalid_span'
        throw new TypeError('Span must be a valid Span object.')
      }
      if (!LLMObsTagger.tagMap.has(span)) {
        err = 'invalid_span'
        throw new Error('Span must be an LLMObs-generated span')
      }
    } catch (e) {
      telemetry.recordExportSpan(span, err)
      throw e
    }
    try {
      return {
        traceId: LLMObsTagger.tagMap.get(span)[TRACE_ID],
        spanId: span.context().toSpanId(),
      }
    } catch {
      err = 'invalid_span'
      logger.warn('Failed to export span. Span must be a valid Span object.')
    } finally {
      telemetry.recordExportSpan(span, err)
    }
  }

  registerProcessor (processor) {
    if (!this.enabled) return

    if (this.#hasUserSpanProcessor) {
      throw new Error(
        '[LLMObs] Only one user span processor can be registered. ' +
        'To register a new processor, deregister the existing processor first using `llmobs.deregisterProcessor()`.'
      )
    }

    this.#hasUserSpanProcessor = true
    registerUserSpanProcessorCh.publish(processor)
  }

  deregisterProcessor () {
    if (!this.enabled) return

    this.#hasUserSpanProcessor = false
    registerUserSpanProcessorCh.publish(null)
  }

  submitEvaluation (llmobsSpanContext, options = {}) {
    if (!this.enabled) return

    let err = ''
    const { traceId, spanId } = llmobsSpanContext
    try {
      if (!traceId || !spanId) {
        err = 'invalid_span'
        throw new Error(
          'spanId and traceId must both be specified for the given evaluation metric to be submitted.'
        )
      }
      const mlApp = options.mlApp || this._config.llmobs.mlApp
      if (!mlApp) {
        err = 'missing_ml_app'
        throw new Error(
          'ML App name is required for sending evaluation metrics. Evaluation metric data will not be sent.'
        )
      }

      const timestampMs = options.timestampMs || Date.now()
      validateTimestamp(timestampMs, 'evaluation')

      const { label, value, tags, reasoning, assessment, metadata } = options
      const metricType = options.metricType?.toLowerCase()
      const labelValue = validateLabel(label, 'evaluation')
      validateMetricType(metricType, 'evaluation')
      validateMetricValue(metricType, value)
      validateAssessment(assessment)
      validateReasoning(reasoning)
      if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
        err = 'invalid_metadata'
        throw new Error('metadata must be a JSON object')
      }

      const payload = {
        event_kind: 'evaluation',
        join_on: {
          span: {
            span_id: spanId,
            trace_id: traceId,
          },
        },
        label: labelValue,
        metric_type: metricType,
        ml_app: mlApp,
        [`${metricType}_value`]: value,
        timestamp_ms: timestampMs,
        // When OTel tracing is enabled, `source:otel` lets the backend wait for OTel span conversion
        tags: buildMetricTags(tags, mlApp, 'evaluation', this._config.DD_TRACE_OTEL_ENABLED),
      }
      if (reasoning != null) {
        payload.reasoning = reasoning
      }
      if (metadata != null) {
        payload.metadata = metadata
      }
      if (assessment != null) {
        payload.assessment = assessment
      }
      const currentStore = storage.getStore()
      const routing = currentStore?.routingContext
      evalMetricAppendCh.publish({ payload, routing })
    } catch (e) {
      if (e.ddErrorTag) err = e.ddErrorTag
      throw e
    } finally {
      telemetry.recordSubmitEvaluation(options, err)
    }
  }

  /**
   * Submits end-user feedback for a span, trace, session, or customer-defined entity.
   *
   * Exactly one target must be provided: `span` (as returned by `llmobs.exportSpan()`) or
   * `spanId` to target a span, `traceId` a trace, `sessionId` a session, or `feedbackJoinKey`
   * a customer-defined entity.
   * `label`, `metricType`, `value` and `submitter` are required, and are validated at call time.
   * @param {object} [options] - The feedback options.
   * @param {string} [options.label] - The name of the feedback metric.
   * @param {'categorical' | 'score' | 'boolean' | 'json' | 'text'} [options.metricType] - The value type.
   * @param {string | number | boolean | Record<string, unknown>} [options.value] - The feedback value,
   *   matching `metricType`.
   * @param {{ id: string, type?: string }} [options.submitter] - Who submitted the feedback.
   * @param {{ traceId: string, spanId: string }} [options.span] - Span context to attach the feedback to.
   * @param {string} [options.spanId] - ID of the span to attach the feedback to.
   * @param {string} [options.traceId] - ID of the trace to attach the feedback to.
   * @param {string} [options.sessionId] - ID of the session to attach the feedback to.
   * @param {string} [options.feedbackJoinKey] - Customer-defined key to attach the feedback to.
   * @param {Record<string, string>} [options.tags] - Tags to attach to the feedback.
   * @param {string} [options.mlApp] - The ML app name. Defaults to the configured one.
   * @param {number} [options.timestampMs] - When the feedback was generated. Defaults to now.
   * @param {'pass' | 'fail'} [options.assessment] - Assessment of the feedback.
   * @param {string} [options.reasoning] - Explanation of the feedback.
   * @returns {void}
   */
  submitFeedback (options = {}) {
    if (!this.enabled) return

    let err = ''
    let targetType = 'other'
    let metricTypeTag = 'other'
    try {
      const { span, spanId, traceId, sessionId, feedbackJoinKey, submitter } = options

      // Resolved before any validation so telemetry still reports the metric type of a
      // submission that fails on an unrelated field.
      const metricType = options.metricType?.toLowerCase()
      if (FEEDBACK_METRIC_TYPES.includes(metricType)) metricTypeTag = metricType

      // The intake keys feedback off a single top-level identifier, so more than one target
      // would be ambiguous and none would leave the feedback unattached. `span` also carries a
      // traceId, but passing it is wire-equivalent to passing its `spanId` directly.
      let targetName, targetValue
      let targetCount = 0
      if (span != null) { targetName = 'span'; targetValue = span.spanId; targetCount++ }
      if (spanId != null) { targetName = 'spanId'; targetValue = spanId; targetCount++ }
      if (traceId != null) { targetName = 'traceId'; targetValue = traceId; targetCount++ }
      if (sessionId != null) { targetName = 'sessionId'; targetValue = sessionId; targetCount++ }
      if (feedbackJoinKey != null) { targetName = 'feedbackJoinKey'; targetValue = feedbackJoinKey; targetCount++ }

      if (targetCount !== 1) {
        err = 'invalid_target_count'
        throw new Error(
          'Exactly one of `span`, `spanId`, `traceId`, `sessionId` or `feedbackJoinKey` ' +
          'must be specified to submit feedback.'
        )
      }

      targetType = FEEDBACK_TARGET_KEYS[targetName]
      if (typeof targetValue !== 'string' || !targetValue) {
        if (targetName === 'span') {
          err = 'invalid_span'
          throw new TypeError(
            '`span` must be an object containing a non-empty string spanId. ' +
            '`llmobs.exportSpan()` can be used to generate this object from a given span.'
          )
        }
        err = `invalid_${targetType}`
        throw new TypeError(`\`${targetName}\` must be a non-empty string`)
      }

      if (typeof submitter?.id !== 'string' || !submitter.id) {
        err = 'invalid_submitter'
        throw new TypeError('submitter must be an object containing a non-empty string id')
      }
      if (submitter.type != null && typeof submitter.type !== 'string') {
        err = 'invalid_submitter'
        throw new TypeError('submitter.type must be a string')
      }

      const mlApp = options.mlApp || this._config.llmobs.mlApp
      if (!mlApp) {
        err = 'missing_ml_app'
        throw new Error('ML App name is required for sending feedback. Feedback data will not be sent.')
      }

      const timestampMs = options.timestampMs || Date.now()
      validateTimestamp(timestampMs, 'feedback')

      const { label, value, tags, reasoning, assessment } = options
      const labelValue = validateLabel(label, 'feedback')
      validateMetricType(metricType, 'feedback')
      validateMetricValue(metricType, value)
      validateAssessment(assessment)
      validateReasoning(reasoning)

      const payload = {
        event_kind: 'feedback',
        [targetType]: targetValue,
        label: labelValue,
        metric_type: metricType,
        ml_app: mlApp,
        [`${metricType}_value`]: value,
        timestamp_ms: timestampMs,
        tags: buildMetricTags(tags, mlApp, 'feedback'),
        submitter: submitter.type == null ? { id: submitter.id } : { id: submitter.id, type: submitter.type },
      }
      if (reasoning != null) {
        payload.reasoning = reasoning
      }
      if (assessment != null) {
        payload.assessment = assessment
      }

      const currentStore = storage.getStore()
      const routing = currentStore?.routingContext
      evalMetricAppendCh.publish({ payload, routing })
    } catch (e) {
      if (e.ddErrorTag) err = e.ddErrorTag
      throw e
    } finally {
      telemetry.recordSubmitFeedback(metricTypeTag, targetType, err)
    }
  }

  annotationContext (options, fn) {
    if (!this.enabled) return fn()

    const currentStore = storage.getStore()

    const store = {
      ...currentStore,
      annotationContext: {
        ...currentStore?.annotationContext,
        ...options,
      },
    }

    return storage.run(store, fn)
  }

  routingContext (options, fn) {
    if (!this.enabled) return fn()
    if (!options?.ddApiKey) {
      throw new Error('ddApiKey is required for routing context')
    }
    const currentStore = storage.getStore()
    if (currentStore?.routingContext) {
      logger.warn(
        '[LLM Observability] Nested routing context detected. Inner context will override outer context. ' +
        'Spans created in the inner context will only be sent to the inner context.'
      )
    }
    const store = {
      ...currentStore,
      routingContext: {
        apiKey: options.ddApiKey,
        site: options.ddSite,
      },
    }
    return storage.run(store, fn)
  }

  flush () {
    if (!this.enabled) return

    flushCh.publish()
  }

  #autoAnnotate (span, kind, input, output) {
    const annotations = {}
    if (input && !['llm', 'embedding'].includes(kind) && !LLMObsTagger.tagMap.get(span)?.[INPUT_VALUE]) {
      annotations.inputData = input
    }

    if (output && !['llm', 'retrieval'].includes(kind) && !LLMObsTagger.tagMap.get(span)?.[OUTPUT_VALUE]) {
      annotations.outputData = output
    }

    this.annotate(span, annotations, true)
  }

  _active () {
    const store = storage.getStore()
    return store?.span
  }

  #activate (span, options, fn) {
    const parentStore = storage.getStore()
    if (this.enabled) storage.enterWith({ ...parentStore, span })

    if (options) {
      this._tagger.registerLLMObsSpan(span, {
        ...options,
        parent: parentStore?.span,
      })
    }

    try {
      return fn()
    } finally {
      if (this.enabled) storage.enterWith(parentStore)
    }
  }

  // bind function to active LLMObs span
  #bind (fn) {
    if (typeof fn !== 'function') return fn

    const llmobs = this
    const activeSpan = llmobs._active()

    return function (...args) {
      return llmobs.#activate(activeSpan, null, () => {
        return fn.apply(this, args)
      })
    }
  }

  #extractOptions (options, kind) {
    const {
      modelName,
      modelProvider,
      sessionId,
      mlApp,
      version,
      _decorator,
      ...spanOptions
    } = options

    if (version != null && kind !== 'agent') {
      logger.warn(`[LLM Observability] The "version" option is only supported on agent spans. Ignoring it for "${
        kind}" spans.`)
    }

    return {
      mlApp,
      modelName,
      modelProvider,
      sessionId,
      version,
      _decorator,
      spanOptions,
    }
  }
}

module.exports = LLMObs

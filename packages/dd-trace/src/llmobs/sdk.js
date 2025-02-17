'use strict'

const { SPAN_KIND, OUTPUT_VALUE, INPUT_VALUE } = require('./constants/tags')

const {
  getFunctionArguments,
  validateKind
} = require('./util')
const { isTrue, isError } = require('../util')

const { storage } = require('./storage')

const Span = require('../opentracing/span')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')

const LLMObsTagger = require('./tagger')

// communicating with writer
const { channel } = require('dc-polyfill')
const evalMetricAppendCh = channel('llmobs:eval-metric:append')
const flushCh = channel('llmobs:writers:flush')
const NoopLLMObs = require('./noop')

class LLMObs extends NoopLLMObs {
  constructor (tracer, llmobsModule, config) {
    super(tracer)

    this._config = config
    this._llmobsModule = llmobsModule
    this._tagger = new LLMObsTagger(config)
  }

  get enabled () {
    return this._config.llmobs.enabled
  }

  enable (options = {}) {
    if (this.enabled) {
      logger.debug('LLMObs is already enabled.')
      return
    }

    logger.debug('Enabling LLMObs')

    const { mlApp, agentlessEnabled } = options

    const { DD_LLMOBS_ENABLED } = process.env

    const llmobsConfig = {
      mlApp,
      agentlessEnabled
    }

    const enabled = DD_LLMOBS_ENABLED == null || isTrue(DD_LLMOBS_ENABLED)
    if (!enabled) {
      logger.debug('LLMObs.enable() called when DD_LLMOBS_ENABLED is false. No action taken.')
      return
    }

    this._config.llmobs.enabled = true
    this._config.configure({ ...this._config, llmobs: llmobsConfig })

    // configure writers and channel subscribers
    this._llmobsModule.enable(this._config)
  }

  disable () {
    if (!this.enabled) {
      logger.debug('LLMObs is already disabled.')
      return
    }

    logger.debug('Disabling LLMObs')

    this._config.llmobs.enabled = false

    // disable writers and channel subscribers
    this._llmobsModule.disable()
  }

  trace (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const kind = validateKind(options.kind) // will throw if kind is undefined or not an expected kind

    // name is required for spans generated with `trace`
    // while `kind` is required, this should never throw (as otherwise it would have thrown above)
    const name = options.name || kind
    if (!name) {
      throw new Error('No span name provided for `trace`.')
    }

    const {
      spanOptions,
      ...llmobsOptions
    } = this._extractOptions(options)

    if (fn.length > 1) {
      return this._tracer.trace(name, spanOptions, (span, cb) =>
        this._activate(span, { kind, options: llmobsOptions }, () => fn(span, cb))
      )
    }

    return this._tracer.trace(name, spanOptions, span =>
      this._activate(span, { kind, options: llmobsOptions }, () => fn(span))
    )
  }

  wrap (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const kind = validateKind(options.kind) // will throw if kind is undefined or not an expected kind
    let name = options.name || (fn?.name ? fn.name : undefined) || kind

    if (!name) {
      logger.warn('No span name provided for `wrap`. Defaulting to "unnamed-anonymous-function".')
      name = 'unnamed-anonymous-function'
    }

    const {
      spanOptions,
      ...llmobsOptions
    } = this._extractOptions(options)

    const llmobs = this

    function wrapped () {
      const span = llmobs._tracer.scope().active()
      const fnArgs = arguments

      const lastArgId = fnArgs.length - 1
      const cb = fnArgs[lastArgId]
      const hasCallback = typeof cb === 'function'

      if (hasCallback) {
        const scopeBoundCb = llmobs._bind(cb)
        fnArgs[lastArgId] = function () {
          // it is standard practice to follow the callback signature (err, result)
          // however, we try to parse the arguments to determine if the first argument is an error
          // if it is not, and is not undefined, we will use that for the output value
          const maybeError = arguments[0]
          const maybeResult = arguments[1]

          llmobs._autoAnnotate(
            span,
            kind,
            getFunctionArguments(fn, fnArgs),
            isError(maybeError) || maybeError == null ? maybeResult : maybeError
          )

          return scopeBoundCb.apply(this, arguments)
        }
      }

      try {
        const result = llmobs._activate(span, { kind, options: llmobsOptions }, () => fn.apply(this, fnArgs))

        if (result && typeof result.then === 'function') {
          return result.then(
            value => {
              if (!hasCallback) {
                llmobs._autoAnnotate(span, kind, getFunctionArguments(fn, fnArgs), value)
              }
              return value
            },
            err => {
              llmobs._autoAnnotate(span, kind, getFunctionArguments(fn, fnArgs))
              throw err
            }
          )
        }

        // it is possible to return a value and have a callback
        // however, since the span finishes when the callback is called, it is possible that
        // the callback is called before the function returns (although unlikely)
        // we do not want to throw for "annotating a finished span" in this case
        if (!hasCallback) {
          llmobs._autoAnnotate(span, kind, getFunctionArguments(fn, fnArgs), result)
        }

        return result
      } catch (e) {
        llmobs._autoAnnotate(span, kind, getFunctionArguments(fn, fnArgs))
        throw e
      }
    }

    return this._tracer.wrap(name, spanOptions, wrapped)
  }

  annotate (span, options) {
    if (!this.enabled) return

    if (!span) {
      span = this._active()
    }

    if ((span && !options) && !(span instanceof Span)) {
      options = span
      span = this._active()
    }

    if (!span) {
      throw new Error('No span provided and no active LLMObs-generated span found')
    }
    if (!options) {
      throw new Error('No options provided for annotation.')
    }

    if (!LLMObsTagger.tagMap.has(span)) {
      throw new Error('Span must be an LLMObs-generated span')
    }
    if (span._duration !== undefined) {
      throw new Error('Cannot annotate a finished span')
    }

    const spanKind = LLMObsTagger.tagMap.get(span)[SPAN_KIND]
    if (!spanKind) {
      throw new Error('LLMObs span must have a span kind specified')
    }

    const { inputData, outputData, metadata, metrics, tags } = options

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

    if (tags) {
      this._tagger.tagSpanTags(span, tags)
    }
  }

  exportSpan (span) {
    span = span || this._active()

    if (!span) {
      throw new Error('No span provided and no active LLMObs-generated span found')
    }

    if (!(span instanceof Span)) {
      throw new Error('Span must be a valid Span object.')
    }

    if (!LLMObsTagger.tagMap.has(span)) {
      throw new Error('Span must be an LLMObs-generated span')
    }

    try {
      return {
        traceId: span.context().toTraceId(true),
        spanId: span.context().toSpanId()
      }
    } catch {
      logger.warn('Faild to export span. Span must be a valid Span object.')
    }
  }

  submitEvaluation (llmobsSpanContext, options = {}) {
    if (!this.enabled) return

    if (!this._config.apiKey) {
      throw new Error(
        'DD_API_KEY is required for sending evaluation metrics. Evaluation metric data will not be sent.\n' +
        'Ensure this configuration is set before running your application.'
      )
    }

    const { traceId, spanId } = llmobsSpanContext
    if (!traceId || !spanId) {
      throw new Error(
        'spanId and traceId must both be specified for the given evaluation metric to be submitted.'
      )
    }

    const mlApp = options.mlApp || this._config.llmobs.mlApp
    if (!mlApp) {
      throw new Error(
        'ML App name is required for sending evaluation metrics. Evaluation metric data will not be sent.'
      )
    }

    const timestampMs = options.timestampMs || Date.now()
    if (typeof timestampMs !== 'number' || timestampMs < 0) {
      throw new Error('timestampMs must be a non-negative integer. Evaluation metric data will not be sent')
    }

    const { label, value, tags } = options
    const metricType = options.metricType?.toLowerCase()
    if (!label) {
      throw new Error('label must be the specified name of the evaluation metric')
    }
    if (!metricType || !['categorical', 'score'].includes(metricType)) {
      throw new Error('metricType must be one of "categorical" or "score"')
    }

    if (metricType === 'categorical' && typeof value !== 'string') {
      throw new Error('value must be a string for a categorical metric.')
    }
    if (metricType === 'score' && typeof value !== 'number') {
      throw new Error('value must be a number for a score metric.')
    }

    const evaluationTags = {
      'ddtrace.version': tracerVersion,
      ml_app: mlApp
    }

    if (tags) {
      for (const key in tags) {
        const tag = tags[key]
        if (typeof tag === 'string') {
          evaluationTags[key] = tag
        } else if (typeof tag.toString === 'function') {
          evaluationTags[key] = tag.toString()
        } else if (tag == null) {
          evaluationTags[key] = Object.prototype.toString.call(tag)
        } else {
          // should be a rare case
          // every object in JS has a toString, otherwise every primitive has its own toString
          // null and undefined are handled above
          throw new Error('Failed to parse tags. Tags for evaluation metrics must be strings')
        }
      }
    }

    const payload = {
      span_id: spanId,
      trace_id: traceId,
      label,
      metric_type: metricType,
      ml_app: mlApp,
      [`${metricType}_value`]: value,
      timestamp_ms: timestampMs,
      tags: Object.entries(evaluationTags).map(([key, value]) => `${key}:${value}`)
    }

    evalMetricAppendCh.publish(payload)
  }

  flush () {
    if (!this.enabled) return

    flushCh.publish()
  }

  _autoAnnotate (span, kind, input, output) {
    const annotations = {}
    if (input && !['llm', 'embedding'].includes(kind) && !LLMObsTagger.tagMap.get(span)?.[INPUT_VALUE]) {
      annotations.inputData = input
    }

    if (output && !['llm', 'retrieval'].includes(kind) && !LLMObsTagger.tagMap.get(span)?.[OUTPUT_VALUE]) {
      annotations.outputData = output
    }

    this.annotate(span, annotations)
  }

  _active () {
    const store = storage.getStore()
    return store?.span
  }

  _activate (span, options, fn) {
    const parent = this._active()
    if (this.enabled) storage.enterWith({ span })

    if (options) {
      this._tagger.registerLLMObsSpan(span, {
        ...options,
        parent
      })
    }

    try {
      return fn()
    } finally {
      if (this.enabled) storage.enterWith({ span: parent })
    }
  }

  // bind function to active LLMObs span
  _bind (fn) {
    if (typeof fn !== 'function') return fn

    const llmobs = this
    const activeSpan = llmobs._active()

    const bound = function () {
      return llmobs._activate(activeSpan, null, () => {
        return fn.apply(this, arguments)
      })
    }

    return bound
  }

  _extractOptions (options) {
    const {
      modelName,
      modelProvider,
      sessionId,
      mlApp,
      ...spanOptions
    } = options

    return {
      mlApp,
      modelName,
      modelProvider,
      sessionId,
      spanOptions
    }
  }
}

module.exports = LLMObs

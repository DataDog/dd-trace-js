'use strict'

const { SPAN_KIND, OUTPUT_VALUE } = require('./constants')

const {
  getFunctionArguments,
  validateKind
} = require('./util')
const { isTrue } = require('../util')

// storage - context management
const { storage } = require('../../../datadog-core')

const Span = require('../opentracing/span')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')

const LLMObsTagger = require('./tagger')

// communicating with writer
const { flushCh, evalMetricAppendCh } = require('./channels')
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

    const { mlApp, agentlessEnabled, apiKey } = options

    const { DD_LLMOBS_ENABLED } = process.env

    const llmobsConfig = {
      mlApp,
      agentlessEnabled,
      apiKey
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
      return this._tracer.trace(name, spanOptions, (span, cb) => {
        const oldStore = storage.getStore()
        const parentLLMObsSpan = oldStore?.llmobsSpan
        if (this.enabled) storage.enterWith({ ...oldStore, llmobsSpan: span })

        this._tagger.setLLMObsSpanTags(span, kind, {
          ...llmobsOptions,
          parentLLMObsSpan
        })

        return fn(span, err => {
          if (this.enabled) storage.enterWith(oldStore)
          cb(err)
        })
      })
    }

    return this._tracer.trace(name, spanOptions, span => {
      const oldStore = storage.getStore()
      const parentLLMObsSpan = oldStore?.llmobsSpan
      if (this.enabled) storage.enterWith({ ...oldStore, llmobsSpan: span })

      this._tagger.setLLMObsSpanTags(span, kind, {
        ...llmobsOptions,
        parentLLMObsSpan
      })

      try {
        const result = fn(span)

        if (result && typeof result.then === 'function') {
          return result.then(value => {
            if (this.enabled) storage.enterWith(oldStore)
            return value
          }).catch(err => {
            if (this.enabled) storage.enterWith(oldStore)
            throw err
          })
        }

        if (this.enabled) storage.enterWith(oldStore)
        return result
      } catch (e) {
        if (this.enabled) storage.enterWith(oldStore)
        throw e
      }
    })
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
      const oldStore = storage.getStore()
      const parentLLMObsSpan = oldStore?.llmobsSpan
      if (llmobs.enabled) storage.enterWith({ ...oldStore, llmobsSpan: span })

      llmobs._tagger.setLLMObsSpanTags(span, kind, {
        ...llmobsOptions,
        parentLLMObsSpan
      })

      if (!['llm', 'embedding'].includes(kind)) {
        llmobs.annotate(span, { inputData: getFunctionArguments(fn, arguments) })
      }

      try {
        const result = fn.apply(this, arguments)

        if (result && typeof result.then === 'function') {
          return result.then(value => {
            if (value && !['llm', 'retrieval'].includes(kind) && !LLMObsTagger.tagMap.get(span)?.[OUTPUT_VALUE]) {
              llmobs.annotate(span, { outputData: value })
            }
            if (llmobs.enabled) storage.enterWith(oldStore)
            return value
          }).catch(err => {
            if (llmobs.enabled) storage.enterWith(oldStore)
            throw err
          })
        }

        if (result && !['llm', 'retrieval'].includes(kind) && !LLMObsTagger.tagMap.get(span)?.[OUTPUT_VALUE]) {
          llmobs.annotate(span, { outputData: result })
          if (llmobs.enabled) storage.enterWith(oldStore)
        }

        return result
      } catch (e) {
        if (llmobs.enabled) storage.enterWith(oldStore)
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

    if (!this._config.llmobs.apiKey && !this._config.apiKey) {
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
      'dd-trace.version': tracerVersion,
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

  _active () {
    const store = storage.getStore()
    return store?.llmobsSpan
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

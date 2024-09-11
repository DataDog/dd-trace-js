'use strict'

const { SPAN_KIND, OUTPUT_VALUE, TRACE_ID } = require('./constants')

const {
  validKind,
  getName,
  isLLMSpan,
  getFunctionArguments
} = require('./util')
const { storage } = require('../../../datadog-core')
const { isTrue } = require('../util')

const Span = require('../opentracing/span')
const LLMObsEvalMetricsWriter = require('./writers/evaluations')
const LLMObsSpanTagger = require('./tagger')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')
const AgentlessWriter = require('./writers/spans/agentless')
const AgentProxyWriter = require('./writers/spans/agentProxy')

class LLMObs {
  constructor (tracer, llmobsModule, config) {
    this._config = config
    this._tracer = tracer
    this._llmobsModule = llmobsModule
    this._tagger = new LLMObsSpanTagger(config)

    if (this.enabled) {
      this._evaluationWriter = new LLMObsEvalMetricsWriter(config)
    }
  }

  get enabled () {
    return this._config.llmobs.enabled
  }

  enable (options = {}) {
    if (this.enabled) {
      logger.debug('LLMObs is already enabled.')
      return
    }

    const { mlApp, agentlessEnabled, apiKey } = options

    const { DD_LLMOBS_ENABLED } = process.env

    const llmobsConfig = {
      mlApp,
      agentlessEnabled,
      apiKey
    }

    const enabled = !DD_LLMOBS_ENABLED || isTrue(DD_LLMOBS_ENABLED)
    if (!enabled) {
      logger.debug('LLMObs.enable() called when DD_LLMOBS_ENABLED is false. No action taken.')
      return
    }

    this._config.llmobs.enabled = !DD_LLMOBS_ENABLED || isTrue(DD_LLMOBS_ENABLED)
    this._config.configure({ ...this._config, llmobs: llmobsConfig })
    this._llmobsModule.enable(this._config)

    // (re)-create writers
    this._evaluationWriter = new LLMObsEvalMetricsWriter(this._config)

    const SpanWriter = this._config.llmobs.agentlessEnabled ? AgentlessWriter : AgentProxyWriter
    this._tracer._processor._llmobs._writer = new SpanWriter(this._config)
  }

  disable () {
    if (!this.enabled) {
      logger.debug('LLMObs is already disabled.')
      return
    }

    logger.debug('Disabling LLMObs')

    this._config.llmobs.enabled = false
    this._llmobsModule.disable()

    this._evaluationWriter.destroy()
    this._tracer._processor._llmobs._writer.destroy()

    this._evaluationWriter = null
    this._tracer._processor._llmobs._writer = null
  }

  annotate (span, options) {
    if (!this.enabled) {
      logger.warn(
        'Annotate called while LLMObs is disabled. Not annotating span.'
      )
      return
    }

    if (!span) {
      span = this.active()
    }

    if ((span && !options) && !(span instanceof Span)) {
      options = span
      span = this.active()
    }

    if (!span) {
      logger.warn('No span provided and no active LLMObs-generated span found')
      return
    }
    if (!options) {
      logger.warn('No options provided for annotation.')
      return
    }

    if (!isLLMSpan(span)) {
      logger.warn('Span must be an LLMObs-generated span')
      return
    }
    if (span._duration !== undefined) {
      logger.warn('Cannot annotate a finished span')
      return
    }

    const spanKind = span.context()._tags[SPAN_KIND]
    if (!spanKind) {
      logger.warn('LLMObs span must have a span kind specified')
      return
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
    if (!this.enabled) {
      logger.warn('Span exported while LLMObs is disabled. Span will not be exported.')
      return
    }

    span = span || this.active()

    if (!span) {
      logger.warn('No span provided and no active LLMObs-generated span found')
      return
    }

    if (!isLLMSpan(span)) {
      logger.warn('Span must be an LLMObs-generated span')
      return
    }

    try {
      return {
        traceId: span.context()._tags[TRACE_ID],
        spanId: span.context().toSpanId()
      }
    } catch {
      logger.warn('Faild to export span. Span must be a valid Span object.')
      return undefined // invalid span kind
    }
  }

  submitEvaluation (llmobsSpanContext, options = {}) {
    if (!this.enabled) {
      logger.warn(
        'LLMObs.submitEvaluation() called when LLMObs is not enabled. Evaluation metric data will not be sent.'
      )
      return
    }

    if (!this._config.llmobs.apiKey || !this._config.apiKey) {
      logger.warn(
        'DD_API_KEY is required for sending evaluation metrics. Evaluation metric data will not be sent.\n' +
        'Ensure this configuration is set before running your application.'
      )
      return
    }

    const { traceId, spanId } = llmobsSpanContext
    if (!traceId || !spanId) {
      logger.warn(
        'spanId and traceId must both be specified for the given evaluation metric to be submitted.'
      )
      return
    }

    const mlApp = options.mlApp || this._config.llmobs.mlApp
    if (!mlApp) {
      logger.warn('ML App name is required for sending evaluation metrics. Evaluation metric data will not be sent.')
      return
    }

    const timestampMs = options.timestampMs || Date.now()
    if (typeof timestampMs !== 'number' || timestampMs < 0) {
      logger.warn('timestampMs must be a non-negative integer. Evaluation metric data will not be sent')
      return
    }

    const { label, value, tags } = options
    const metricType = options.metricType?.toLowerCase()
    if (!label) {
      logger.warn('label must be the specified name of the evaluation metric')
      return
    }
    if (!metricType || !['categorical', 'score'].includes(metricType)) {
      logger.warn('metricType must be one of "categorical" or "score"')
      return
    }

    if (metricType === 'categorical' && typeof value !== 'string') {
      logger.warn('value must be a string for a categorical metric.')
      return
    }
    if (metricType === 'score' && typeof value !== 'number') {
      logger.warn('value must be a number for a score metric.')
      return
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
        } else {
          logger.warn('Failed to parse tags. Tags for evaluation metrics must be strings')
        }
      }
    }

    this._evaluationWriter.append({
      span_id: spanId,
      trace_id: traceId,
      label,
      metric_type: metricType,
      ml_app: mlApp,
      [`${metricType}_value`]: value,
      timestamp_ms: timestampMs,
      tags: Object.entries(evaluationTags).map(([key, value]) => `${key}:${value}`)
    })
  }

  startSpan (kind, options = {}) {
    if (!this.enabled) {
      logger.warn('Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.')
    }

    const valid = validKind(kind)
    if (!valid) {
      logger.warn(`Invalid span kind specified: ${kind}. Span will not be sent to LLM Observability.`)
    }

    const name = getName(kind, options)

    const {
      spanOptions,
      ...llmobsOptions
    } = this._extractOptions(options)

    const span = this._tracer.startSpan(name, {
      ...spanOptions,
      childOf: this._tracer.scope().active()
    })

    const oldStore = storage.getStore()
    const parentLLMObsSpan = oldStore?.llmobsSpan

    this._tagger.setLLMObsSpanTags(span, valid && kind, {
      ...llmobsOptions,
      parentLLMObsSpan
    })
    const newStore = span ? span._store : oldStore

    storage.enterWith({ ...newStore, span, llmobsSpan: span }) // preserve context

    return new Proxy(span, {
      get (target, key) {
        if (key === 'finish') {
          return function () {
            storage.enterWith(oldStore) // restore context
            return span.finish.apply(span, arguments)
          }
        }

        return target[key]
      }
    })
  }

  trace (kind, options, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    if (!this.enabled) {
      logger.warn('Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.')
    }

    const valid = validKind(kind)
    if (!valid) {
      logger.warn(`Invalid span kind specified: ${kind}. Span will not be sent to LLM Observability.`)
    }

    const name = getName(kind, options)

    const {
      spanOptions,
      ...llmobsOptions
    } = this._extractOptions(options)

    if (fn.length > 1) {
      return this._tracer.trace(name, spanOptions, (span, cb) => {
        const oldStore = storage.getStore()
        const parentLLMObsSpan = oldStore?.llmobsSpan
        storage.enterWith({ ...oldStore, llmobsSpan: span })

        this._tagger.setLLMObsSpanTags(span, valid && kind, {
          ...llmobsOptions,
          parentLLMObsSpan
        })

        return fn(span, err => {
          // is this needed? with the use of `activate` internally, it should restore
          // the context from what it was before the `enterWith` above...
          storage.enterWith(oldStore)
          cb(err)
        })
      })
    }

    return this._tracer.trace(name, spanOptions, span => {
      const oldStore = storage.getStore()
      const parentLLMObsSpan = oldStore?.llmobsSpan
      storage.enterWith({ ...oldStore, llmobsSpan: span })

      this._tagger.setLLMObsSpanTags(span, valid && kind, {
        ...llmobsOptions,
        parentLLMObsSpan
      })

      try {
        const result = fn(span)

        if (result && typeof result.then === 'function') {
          return result.then(value => {
            storage.enterWith(oldStore)
            return value
          }).catch(err => {
            storage.enterWith(oldStore)
            throw err
          })
        }

        storage.enterWith(oldStore)
        return result
      } catch (e) {
        storage.enterWith(oldStore)
        throw e
      }
    })
  }

  wrap (kind, options, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const name = getName(kind, options, fn)

    const {
      spanOptions,
      ...llmobsOptions
    } = this._extractOptions(options)

    const llmobs = this

    function wrapped () {
      if (!llmobs.enabled) {
        logger.warn('Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.')
      }

      const valid = validKind(kind)
      if (!valid) {
        logger.warn(`Invalid span kind specified: ${kind}. Span will not be sent to LLM Observability.`)
      }

      const span = llmobs._tracer.scope().active()
      const oldStore = storage.getStore()
      const parentLLMObsSpan = oldStore?.llmobsSpan
      storage.enterWith({ ...oldStore, llmobsSpan: span })

      llmobs._tagger.setLLMObsSpanTags(span, valid && kind, {
        ...llmobsOptions,
        parentLLMObsSpan
      })
      llmobs.annotate(span, { inputData: getFunctionArguments(fn, arguments) })

      try {
        const result = fn.apply(this, arguments)

        if (result && typeof result.then === 'function') {
          return result.then(value => {
            if (value && kind !== 'retrieval' && !span.context()._tags[OUTPUT_VALUE]) {
              llmobs.annotate(span, { outputData: value })
            }
            storage.enterWith(oldStore)
            return value
          }).catch(err => {
            storage.enterWith(oldStore)
            throw err
          })
        }

        if (result && kind !== 'retrieval' && !span.context()._tags[OUTPUT_VALUE]) {
          llmobs.annotate(span, { outputData: result })
          storage.enterWith(oldStore)
        }

        return result
      } catch (e) {
        storage.enterWith(oldStore)
        throw e
      }
    }

    return this._tracer.wrap(name, spanOptions, wrapped) // try and have it call `startSpan` for this class
  }

  decorate (kind, options) {
    const llmobs = this
    return function (target, ctx) {
      if (!llmobs.enabled || ctx.kind !== 'method') return target

      // override name if specified on options
      return llmobs.wrap(kind, { name: ctx.name, ...options }, target)
    }
  }

  flush () {
    if (!this.enabled) {
      logger.warn('Flushing when LLMObs is disabled. no spans or evaluation metrics will be sent')
      return
    }

    try {
      this._tracer._processor._llmobs._writer.flush()
      this._evaluationWriter.flush()
    } catch {
      logger.warn('Failed to flush LLMObs spans and evaluation metrics')
    }
  }

  active () {
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

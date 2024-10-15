'use strict'

const { SPAN_KIND, OUTPUT_VALUE } = require('./constants')

const {
  validKind,
  getName,
  getFunctionArguments
} = require('./util')
const { isTrue } = require('../util')

// storage - context management
const { storage } = require('../../../datadog-core')

const Span = require('../opentracing/span')

const tracerVersion = require('../../../../package.json').version
const logger = require('../log')

const AgentlessWriter = require('./writers/spans/agentless')
const AgentProxyWriter = require('./writers/spans/agentProxy')
const LLMObsSpanProcessor = require('./span_processor')
const LLMObsEvalMetricsWriter = require('./writers/evaluations')
const LLMObsTagger = require('./tagger')

// communicating with span processing
const { channel } = require('dc-polyfill')
const spanProccessCh = channel('dd-trace:span:process')

class LLMObs {
  constructor (tracer, llmobsModule, config) {
    this._config = config
    this._tracer = tracer
    this._llmobsModule = llmobsModule
    this._tagger = new LLMObsTagger(config)
    this._processor = new LLMObsSpanProcessor(config)

    this._handleSpanProcess = data => this._processor.process(data)

    this._enable()
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
    this._llmobsModule.enable(this._config)

    this._enable()
  }

  disable () {
    if (!this.enabled) {
      logger.debug('LLMObs is already disabled.')
      return
    }

    logger.debug('Disabling LLMObs')

    this._config.llmobs.enabled = false
    this._llmobsModule.disable()

    spanProccessCh.unsubscribe(this._handleSpanProcess)

    this._evaluationWriter.destroy()
    this._spanWriter.destroy()

    this._evaluationWriter = null
    this._spanWriter = null
    this._processor.setWriter(null)
  }

  startSpan (options = {}) {
    if (!this.enabled) {
      logger.warn('Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.')
    }

    const kind = options.kind
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

    // we need the span to finish in the same context it was started
    const originalFinish = span.finish
    span.finish = function () {
      span.finish = originalFinish
      storage.enterWith(oldStore)
      return originalFinish.apply(span, arguments)
    }

    const oldStore = storage.getStore()
    const parentLLMObsSpan = oldStore?.llmobsSpan

    this._tagger.setLLMObsSpanTags(span, valid && kind, {
      ...llmobsOptions,
      parentLLMObsSpan
    })
    const newStore = span ? span._store : oldStore

    if (this.enabled) {
      storage.enterWith({ ...newStore, span, llmobsSpan: span })
    } else {
      storage.enterWith({ ...newStore, span })
    }

    return span
  }

  trace (options = {}, fn) {
    if (!this.enabled) {
      logger.warn('Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.')
    }

    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const kind = options.kind
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
        if (this.enabled) storage.enterWith({ ...oldStore, llmobsSpan: span })

        this._tagger.setLLMObsSpanTags(span, valid && kind, {
          ...llmobsOptions,
          parentLLMObsSpan
        })

        return fn(span, err => {
          storage.enterWith(oldStore)
          cb(err)
        })
      })
    }

    return this._tracer.trace(name, spanOptions, span => {
      const oldStore = storage.getStore()
      const parentLLMObsSpan = oldStore?.llmobsSpan
      if (this.enabled) storage.enterWith({ ...oldStore, llmobsSpan: span })

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

  wrap (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const kind = options.kind
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
      if (llmobs.enabled) storage.enterWith({ ...oldStore, llmobsSpan: span })

      llmobs._tagger.setLLMObsSpanTags(span, valid && kind, {
        ...llmobsOptions,
        parentLLMObsSpan
      })
      llmobs.annotate(span, { inputData: getFunctionArguments(fn, arguments) })

      try {
        const result = fn.apply(this, arguments)

        if (result && typeof result.then === 'function') {
          return result.then(value => {
            if (value && kind !== 'retrieval' && !LLMObsTagger.tagMap.get(span)?.[OUTPUT_VALUE]) {
              llmobs.annotate(span, { outputData: value })
            }
            storage.enterWith(oldStore)
            return value
          }).catch(err => {
            storage.enterWith(oldStore)
            throw err
          })
        }

        if (result && kind !== 'retrieval' && !LLMObsTagger.tagMap.get(span)?.[OUTPUT_VALUE]) {
          llmobs.annotate(span, { outputData: result })
          storage.enterWith(oldStore)
        }

        return result
      } catch (e) {
        storage.enterWith(oldStore)
        throw e
      }
    }

    return this._tracer.wrap(name, spanOptions, wrapped)
  }

  decorate (options = {}) {
    const llmobs = this
    return function (target, ctxOrPropertyKey, descriptor) {
      if (!ctxOrPropertyKey) return target
      if (typeof ctxOrPropertyKey === 'object') {
        const ctx = ctxOrPropertyKey
        if (ctx.kind !== 'method') return target

        return llmobs.wrap(target, { name: ctx.name, ...options })
      } else {
        const propertyKey = ctxOrPropertyKey
        if (descriptor) {
          if (typeof descriptor.value !== 'function') return descriptor

          const original = descriptor.value
          descriptor.value = llmobs.wrap(original, { name: propertyKey, ...options })

          return descriptor
        } else {
          if (typeof target[propertyKey] !== 'function') return target[propertyKey]

          const original = target[propertyKey]
          Object.defineProperty(target, propertyKey, {
            ...Object.getOwnPropertyDescriptor(target, propertyKey),
            value: llmobs.wrap(original, { name: propertyKey, ...options })
          })

          return target
        }
      }
    }
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

    if (!LLMObsTagger.tagMap.has(span)) {
      logger.warn('Span must be an LLMObs-generated span')
      return
    }
    if (span._duration !== undefined) {
      logger.warn('Cannot annotate a finished span')
      return
    }

    const spanKind = LLMObsTagger.tagMap.get(span)[SPAN_KIND]
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

    if (!(span instanceof Span)) {
      logger.warn('Span must be a valid Span object.')
      return
    }

    if (!LLMObsTagger.tagMap.has(span)) {
      logger.warn('Span must be an LLMObs-generated span')
      return
    }

    try {
      return {
        traceId: span.context().toTraceId(true),
        spanId: span.context().toSpanId()
      }
    } catch {
      logger.warn('Faild to export span. Span must be a valid Span object.')
      return undefined
    }
  }

  submitEvaluation (llmobsSpanContext, options = {}) {
    if (!this.enabled) {
      logger.warn(
        'LLMObs.submitEvaluation() called when LLMObs is not enabled. Evaluation metric data will not be sent.'
      )
      return
    }

    if (!this._config.llmobs.apiKey && !this._config.apiKey) {
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

  flush () {
    if (!this.enabled) {
      logger.warn('Flushing when LLMObs is disabled. No spans or evaluation metrics will be sent')
      return
    }

    try {
      this._processor._writer.flush()
      this._evaluationWriter.flush()
    } catch {
      logger.warn('Failed to flush LLMObs spans and evaluation metrics')
    }
  }

  active () {
    const store = storage.getStore()
    return store?.llmobsSpan
  }

  _enable () {
    this._evaluationWriter = new LLMObsEvalMetricsWriter(this._config)
    this._spanWriter = this._createSpanWriter()

    this._processor.setWriter(this._spanWriter)
    spanProccessCh.subscribe(this._handleSpanProcess)
  }

  _createSpanWriter () {
    const SpanWriter = this._config.llmobs.agentlessEnabled ? AgentlessWriter : AgentProxyWriter
    return new SpanWriter(this._config)
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

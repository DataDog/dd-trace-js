'use strict'

const { SPAN_KIND } = require('./constants')

const {
  validateKind,
  getName,
  isLLMSpan
} = require('./utils')
const { storage } = require('../../../datadog-core')

const NoopLLMObs = require('./noop')
const Span = require('../opentracing/span')
const LLMObsEvalMetricsWriter = require('./writers/evaluations')
const LLMObsSpanTagger = require('./tagger')

const { DD_MAJOR, DD_MINOR, DD_PATCH } = require('../../../../version')
const TRACER_VERSION = `${DD_MAJOR}.${DD_MINOR}.${DD_PATCH}`

class LLMObs extends NoopLLMObs {
  constructor (tracer, config) {
    super()

    this._config = config
    this._tracer = tracer
    this._tagger = new LLMObsSpanTagger(config)

    this._evaluationWriter = new LLMObsEvalMetricsWriter({
      site: config.site,
      apiKey: config.apiKey
    })
  }

  get enabled () {
    return this._config.llmobs.enabled
  }

  enable (options) {}

  disable () {}

  annotate (span, options) {
    if (!this.enabled) return

    if (!span) {
      span = this._tracer.scope().active()
    }

    if (!(span instanceof Span)) {
      options = span
      span = this._tracer.scope().active()
    }

    if (!span) return
    if (!isLLMSpan(span)) return
    if (span._duration !== undefined) return

    const spanKind = span.context()._tags[SPAN_KIND]
    if (!spanKind) return

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
    if (!this.enabled) return
    try {
      span = span || this._tracer.scope().active()

      if (!isLLMSpan(span)) return

      return {
        traceId: span.context().toTraceId(true),
        spanId: span.context()._spanId.toString(10)
      }
    } catch {
      return undefined // invalid span kind
    }
  }

  submitEvaluation (llmobsSpanContext, options) {
    if (!this.enabled) return

    const { traceId, spanId } = llmobsSpanContext
    if (!traceId || !spanId) return

    const { label, value, tags } = options
    const metricType = options.metricType.toLowerCase()
    if (!label) return
    if (!metricType || !['categorical', 'score'].includes(metricType)) return

    if (metricType === 'categorical' && typeof value !== 'string') return
    if (metricType === 'score' && typeof value !== 'number') return

    const evaluationTags = { 'dd-trace.version': TRACER_VERSION, ml_app: this._config.llmobs.mlApp }

    if (tags) {
      for (const key in tags) {
        const tag = tags[key]
        if (typeof tag === 'string') {
          evaluationTags[key] = tag
        } else if (typeof tag.toString === 'function') {
          evaluationTags[key] = tag.toString()
        }
      }
    }

    this._evaluationWriter.append({
      span_id: spanId,
      trace_id: traceId,
      label,
      metric_type: metricType,
      [`${metricType}_value`]: value,
      tags: Object.entries(evaluationTags).map(([key, value]) => `${key}:${value}`)
    })
  }

  startSpan (kind, options) {
    if (!this.enabled) return
    validateKind(kind)

    const name = getName(kind, options)

    const {
      spanOptions,
      ...llmobsOptions
    } = this._extractOptions(options)

    const span = this._tracer.startSpan(name, {
      ...spanOptions,
      childOf: this._tracer.scope().active()
    })

    this._tagger.setLLMObsSpanTags(span, kind, llmobsOptions)

    const oldStore = storage.getStore()
    const newStore = span ? span._store : oldStore

    storage.enterWith({ ...newStore, span }) // preserve context

    return new Proxy(span, {
      get (target, key) {
        if (key === 'finish') {
          return function () {
            // some LLMObs processing
            storage.enterWith(oldStore) // restore context
            return span.finish.apply(this, arguments)
          }
        }

        return target[key]
      }
    })
  }

  trace (kind, options, fn) {
    if (!this.enabled) return
    validateKind(kind)

    const name = getName(kind, options)

    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const {
      spanOptions,
      ...llmobsOptions
    } = this._extractOptions(options)

    if (fn.length > 1) {
      return this._tracer.trace(name, spanOptions, (span, cb) => {
        // do some llmobs processing
        this._tagger.setLLMObsSpanTags(span, kind, llmobsOptions)
        return fn(span, cb)
      })
    }

    return this._tracer.trace(name, spanOptions, span => {
      // do some llmobs processing
      this._tagger.setLLMObsSpanTags(span, kind, llmobsOptions)
      return fn(span)
    })
  }

  wrap (kind, options, fn) {
    if (!this.enabled) return
    validateKind(kind)

    const name = getName(kind, options, fn)

    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const {
      spanOptions,
      ...llmobsOptions
    } = this._extractOptions(options)

    const llmobsThis = this

    function wrapped () {
      const args = arguments
      const span = llmobsThis._tracer.scope().active()

      llmobsThis._tagger.setLLMObsSpanTags(span, kind, llmobsOptions)

      const result = fn.apply(this, args)
      // do some after function llmobs processing
      return result
    }

    return this._tracer.wrap(name, spanOptions, wrapped)
  }

  flush () {
    if (!this.enabled) return

    try {
      this._tracer._processor._llmobs._writer.flush()
      this._evaluationWriter.flush()
    } catch {
      // log error
    }
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

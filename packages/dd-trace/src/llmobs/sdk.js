'use strict'

const {
  SPAN_TYPE
} = require('../../../../ext/tags')
const {
  PROPAGATED_PARENT_ID_KEY,
  MODEL_NAME,
  MODEL_PROVIDER,
  SESSION_ID,
  ML_APP,
  SPAN_KIND,
  INPUT_VALUE,
  OUTPUT_DOCUMENTS,
  INPUT_DOCUMENTS,
  OUTPUT_VALUE,
  METADATA,
  METRICS,
  PARENT_ID_KEY,
  INPUT_MESSAGES,
  OUTPUT_MESSAGES
} = require('./constants')

const {
  validateKind,
  getName,
  getLLMObsParentId,
  getMlApp,
  isLLMSpan,
  getSessionId
} = require('./utils')
const { storage } = require('../../../datadog-core')

const NoopLLMObs = require('./noop')
const Span = require('../opentracing/span')
const LLMObsEvalMetricsWriter = require('./writers/evaluations')

const { DD_MAJOR, DD_MINOR, DD_PATCH } = require('../../../../version')
const TRACER_VERSION = `${DD_MAJOR}.${DD_MINOR}.${DD_PATCH}`

class LLMObs extends NoopLLMObs {
  constructor (tracer, config) {
    super()

    this._config = config
    this._tracer = tracer

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
        this._tagLLMIO(span, inputData, outputData)
      } else if (spanKind === 'embedding') {
        this._tagEmbeddingIO(span, inputData, outputData)
      } else if (spanKind === 'retrieval') {
        this._tagRetrievalIO(span, inputData, outputData)
      } else {
        this._tagTextIO(span, inputData, outputData)
      }
    }

    if (metadata) {
      this._tagMetadata(span, metadata)
    }

    if (metrics) {
      this._tagMetrics(span, metrics)
    }

    if (tags) {
      this._tagSpanTags(span, tags)
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

    const span = this._tracer.startSpan(name, {
      ...options,
      childOf: this._tracer.scope().active()
    })

    this._startLLMObsSpan(span, kind, options)

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

    if (fn.length > 1) {
      return this._tracer.trace(name, options, (span, cb) => {
        // do some llmobs processing
        this._startLLMObsSpan(span, kind, options)
        return fn(span, cb)
      })
    }

    return this._tracer.trace(name, options, span => {
      // do some llmobs processing
      this._startLLMObsSpan(span, kind, options)
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

    const llmobsThis = this

    function wrapped () {
      const args = arguments
      const span = llmobsThis._tracer.scope().active()

      llmobsThis._startLLMObsSpan(span, kind, options)

      const result = fn.apply(this, args)
      // do some after function llmobs processing
      return result
    }

    return this._tracer.wrap(name, options, wrapped)
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

  _startLLMObsSpan (span, kind, { modelName, modelProvider, sessionId, mlApp }) {
    span.setTag(SPAN_TYPE, 'llm')

    span.setTag(SPAN_KIND, kind)
    if (modelName) span.setTag(MODEL_NAME, modelName)
    if (modelProvider) span.setTag(MODEL_PROVIDER, modelProvider)

    if (!sessionId) sessionId = getSessionId(span)
    span.setTag(SESSION_ID, sessionId)

    if (!mlApp) mlApp = getMlApp(span, this._config.llmobs.mlApp)
    span.setTag(ML_APP, mlApp)

    if (!span.context()._tags[PROPAGATED_PARENT_ID_KEY]) {
      const parentId = getLLMObsParentId(span) || 'undefined'
      span.setTag(PARENT_ID_KEY, parentId)
    }
  }

  _tagLLMIO (span, inputData, outputData) {
    this._tagMessages(span, inputData, INPUT_MESSAGES)
    this._tagMessages(span, outputData, OUTPUT_MESSAGES)
  }

  _tagEmbeddingIO (span, inputData, outputData) {
    this._tagDocuments(span, inputData, INPUT_DOCUMENTS)
    this._tagText(span, outputData, OUTPUT_VALUE)
  }

  _tagRetrievalIO (span, inputData, outputData) {
    this._tagText(span, inputData, INPUT_VALUE)
    this._tagDocuments(span, outputData, OUTPUT_DOCUMENTS)
  }

  _tagTextIO (span, inputData, outputData) {
    this._tagText(span, inputData, INPUT_VALUE)
    this._tagText(span, outputData, OUTPUT_VALUE)
  }

  _tagText (span, data, key) {
    if (data) {
      if (typeof data === 'string') {
        span.setTag(key, data)
      } else {
        try {
          span.setTag(key, JSON.stringify(data))
        } catch {
          // log error
        }
      }
    }
  }

  _tagMetadata (span, metadata) {
    try {
      span.setTag(METADATA, JSON.stringify(metadata))
    } catch {
      // log error
    }
  }

  _tagMetrics (span, metrics) {
    try {
      span.setTag(METRICS, JSON.stringify(metrics))
    } catch {
      // log error
    }
  }

  _tagSpanTags (span, tags) {}

  _tagDocuments (span, data, key) {
    if (data) {
      if (!Array.isArray(data)) {
        data = [data]
      }

      try {
        const documents = data.map(document => {
          if (typeof document === 'string') {
            return document
          }

          const { text, name, id, score } = document

          if (text && typeof text !== 'string') {
            return undefined
          }

          if (name && typeof name !== 'string') {
            return undefined
          }

          if (id && typeof id !== 'string') {
            return undefined
          }

          if (score && typeof score !== 'number') {
            return undefined
          }

          return document
        }).filter(doc => !!doc) // filter out bad documents?

        span.setTag(key, JSON.stringify(documents))
      } catch {
        // log error
      }
    }
  }

  _tagMessages (span, data, key) {
    if (data) {
      if (!Array.isArray(data)) {
        data = [data]
      }

      try {
        const messages = data.map(message => {
          if (typeof message === 'string') {
            return message
          }

          const content = message.content || ''
          const role = message.role

          if (typeof content !== 'string') {
            return undefined
          }

          if (role && typeof role !== 'string') {
            return undefined
          }

          return message
        }).filter(msg => !!msg) // filter out bad messages?

        span.setTag(key, JSON.stringify(messages))
      } catch {
        // log error
      }
    }
  }
}

module.exports = LLMObs

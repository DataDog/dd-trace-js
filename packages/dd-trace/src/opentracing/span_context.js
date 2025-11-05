'use strict'

const util = require('util')
const { AUTO_KEEP } = require('../../../../ext/priority')

const {
  SAMPLING_RULE_DECISION,
  SAMPLING_LIMIT_DECISION,
  SAMPLING_AGENT_DECISION,
  TOP_LEVEL_KEY
} = require('../constants');

// the lowercase, hex encoded upper 64 bits of a 128-bit trace id, if present
const TRACE_ID_128 = '_dd.p.tid'

function getChunkRoot (self) {
  return self._trace.started[0]?.context() || self
}

function assignRootTag (self, prop, val) {
  const chunkRoot = getChunkRoot(self)
  if (!chunkRoot._parentId || chunkRoot._parentId.toString(10) === '0') {
    chunkRoot._tags[SAMPLING_RULE_DECISION] = val
    chunkRoot._tags[TOP_LEVEL_KEY] = 1
  }
}

class DatadogSpanContext {
  constructor (props) {
    props = props || {}

    this._traceId = props.traceId
    this._spanId = props.spanId
    this._isRemote = props.isRemote ?? true
    this._parentId = props.parentId || null
    this._name = props.name
    this._isFinished = props.isFinished || false
    this._tags = props.tags || {}
    this._sampling = props.sampling || {}
    this._spanSampling = undefined
    this._links = props.links || []
    this._baggageItems = props.baggageItems || {}
    this._traceparent = props.traceparent
    this._tracestate = props.tracestate
    this._noop = props.noop || null
    const self = this
    this._trace = props.trace || {
      started: [],
      finished: [],
      set [SAMPLING_RULE_DECISION] (val) {
        assignRootTag(self, SAMPLING_RULE_DECISION, val)
      },
      set [SAMPLING_LIMIT_DECISION] (val) {
        assignRootTag(self, SAMPLING_LIMIT_DECISION, val)
      },
      set [SAMPLING_AGENT_DECISION] (val) {
        assignRootTag(self, SAMPLING_AGENT_DECISION, val)
      }
    }
    if (!props.trace) {
      Object.defineProperty(this._trace, 'tags', {
        enumerable: true,
        get () {
          return (self._trace.started[0]?.context() || self)._tags
        }
      })
    }
    this._otelSpanContext = undefined
  }

  setChunkTag (name, val) {
    this._trace.started[0].setTag(name, val)
  }

  [util.inspect.custom] () {
    return {
      ...this,
      _trace: {
        ...this._trace,
        started: '[Array]',
        finished: '[Array]'
      }
    }
  }

  toTraceId (get128bitId = false) {
    if (get128bitId) {
      return this._traceId.toBuffer().length <= 8 && this._trace.tags[TRACE_ID_128]
        ? this._trace.tags[TRACE_ID_128] + this._traceId.toString(16).padStart(16, '0')
        : this._traceId.toString(16).padStart(32, '0')
    }
    return this._traceId.toString(10)
  }

  toSpanId (get128bitId = false) {
    if (get128bitId) {
      return this._spanId.toString(16).padStart(16, '0')
    }
    return this._spanId.toString(10)
  }

  toBigIntSpanId () {
    return this._spanId.toBigInt()
  }

  toTraceparent () {
    const flags = this._sampling.priority >= AUTO_KEEP ? '01' : '00'
    const traceId = this.toTraceId(true)
    const spanId = this.toSpanId(true)
    const version = (this._traceparent && this._traceparent.version) || '00'
    return `${version}-${traceId}-${spanId}-${flags}`
  }
}

module.exports = DatadogSpanContext

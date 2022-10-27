'use strict'

const StoragePlugin = require('./storage')

class DatabasePlugin extends StoragePlugin {
  static get operation () { return 'query' }

  constructor (...args) {
    super(...args)
    this.serviceTags = {
      dddbs: '',
      encodedDddbs: '',
      dde: '',
      encodedDde: '',
      ddps: '',
      encodedDdps: '',
      ddpv: '',
      encodedDdpv: ''
    }
  }
  encodingServiceTags (serviceTag, encodeATag, spanConfig) {
    if (serviceTag !== spanConfig) {
      this.serviceTags[serviceTag] = spanConfig
      this.serviceTags[encodeATag] = encodeURIComponent(spanConfig)
    }
  }

  createDBMPropagationCommentService () {
    this.encodingServiceTags('dddbs', 'encodedDddbs', this.config.service)
    this.encodingServiceTags('dde', 'encodedDde', this.tracer._env)
    this.encodingServiceTags('ddps', 'encodedDdps', this.tracer._service)
    this.encodingServiceTags('ddpv', 'encodedDdpv', this.tracer._version)

    const { encodedDddbs, encodedDde, encodedDdps, encodedDdpv } = this.serviceTags

    return `dddbs='${encodedDddbs}',dde='${encodedDde}',` +
    `ddps='${encodedDdps}',ddpv='${encodedDdpv}'`
  }

  // TODO create the buildTraceparent as a helper function function possibly in trace
  // agent core to be used by both Db plugins and TextMapPropagator
  buildTraceparent () {
    const span = this.activeSpan._spanContext
    const sampling = span._sampling.priority > 0 ? '01' : '00'
    const traceId = span._traceId.toString(16).padStart(32, '0')
    const spanId = span._spanId.toString(16).padStart(16, '0')
    return `01-${traceId}-${spanId}-${sampling}`
  }

  injectDbmQuery (query) {
    if (this.config.dbmPropagationMode === 'disabled') {
      return query
    }
    const servicePropagation = this.createDBMPropagationCommentService()
    if (this.config.dbmPropagationMode === 'service') {
      return `/*${servicePropagation}*/ ${query}`
    } else if (this.config.dbmPropagationMode === 'full') {
      this.activeSpan.setTag('_dd.dbm_trace_injected', 'true')
      const traceparent = this.buildTraceparent()
      return `/*${servicePropagation},traceparent='${traceparent}'*/ ${query}`
    }
  }
}

module.exports = DatabasePlugin

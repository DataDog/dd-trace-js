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

  createDBMPropagationCommentService (serviceName) {
    this.encodingServiceTags('dddbs', 'encodedDddbs', serviceName)
    this.encodingServiceTags('dde', 'encodedDde', this.tracer._env)
    this.encodingServiceTags('ddps', 'encodedDdps', this.tracer._service)
    this.encodingServiceTags('ddpv', 'encodedDdpv', this.tracer._version)

    const { encodedDddbs, encodedDde, encodedDdps, encodedDdpv } = this.serviceTags

    return `dddbs='${encodedDddbs}',dde='${encodedDde}',` +
    `ddps='${encodedDdps}',ddpv='${encodedDdpv}'`
  }

  injectDbmQuery (query, serviceName) {
    if (this.config.dbmPropagationMode === 'disabled') {
      return query
    }
    const servicePropagation = this.createDBMPropagationCommentService(serviceName)
    if (this.config.dbmPropagationMode === 'service') {
      return `/*${servicePropagation}*/ ${query}`
    } else if (this.config.dbmPropagationMode === 'full') {
      this.activeSpan.setTag('_dd.dbm_trace_injected', 'true')
      const traceparent = this.activeSpan._spanContext.toTraceparent()
      return `/*${servicePropagation},traceparent='${traceparent}'*/ ${query}`
    }
  }
}

module.exports = DatabasePlugin

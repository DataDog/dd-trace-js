'use strict'

const StoragePlugin = require('./storage')
const { PEER_SERVICE_KEY } = require('../constants')

class DatabasePlugin extends StoragePlugin {
  static get operation () { return 'query' }
  static get peerServicePrecursors () { return ['db.name'] }

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

  getDbmServiceName (span, tracerService) {
    if (this._tracerConfig.spanComputePeerService) {
      const peerData = this.getPeerService(span.context()._tags)
      return this.getPeerServiceRemap(peerData)[PEER_SERVICE_KEY] || tracerService
    }
    return tracerService
  }

  injectDbmQuery (span, query, serviceName, isPreparedStatement = false) {
    const mode = this.config.dbmPropagationMode
    const dbmService = this.getDbmServiceName(span, serviceName)

    if (mode === 'disabled') {
      return query
    }

    const servicePropagation = this.createDBMPropagationCommentService(dbmService)

    if (isPreparedStatement || mode === 'service') {
      return `/*${servicePropagation}*/ ${query}`
    } else if (mode === 'full') {
      span.setTag('_dd.dbm_trace_injected', 'true')
      const traceparent = span._spanContext.toTraceparent()
      return `/*${servicePropagation},traceparent='${traceparent}'*/ ${query}`
    }
  }

  maybeTruncate (query) {
    const maxLength = typeof this.config.truncate === 'number'
      ? this.config.truncate
      : 5000 // same as what the agent does

    if (this.config.truncate && query && query.length > maxLength) {
      query = `${query.slice(0, maxLength - 3)}...`
    }

    return query
  }
}

module.exports = DatabasePlugin

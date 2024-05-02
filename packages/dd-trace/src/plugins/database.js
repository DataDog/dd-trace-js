'use strict'

const StoragePlugin = require('./storage')
const { PEER_SERVICE_KEY, PEER_SERVICE_SOURCE_KEY } = require('../constants')

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

  createDBMPropagationCommentService (serviceName, span) {
    this.encodingServiceTags('dddbs', 'encodedDddbs', serviceName)
    this.encodingServiceTags('dde', 'encodedDde', this.tracer._env)
    this.encodingServiceTags('ddps', 'encodedDdps', this.tracer._service)
    this.encodingServiceTags('ddpv', 'encodedDdpv', this.tracer._version)
    if (span.context()._tags['out.host']) {
      this.encodingServiceTags('ddh', 'encodedDdh', span._spanContext._tags['out.host'])
    }
    if (span.context()._tags['db.name']) {
      this.encodingServiceTags('dddb', 'encodedDddb', span._spanContext._tags['db.name'])
    }

    const { encodedDddb, encodedDddbs, encodedDde, encodedDdh, encodedDdps, encodedDdpv } = this.serviceTags

    let dbmComment = `dddb='${encodedDddb}',dddbs='${encodedDddbs}',dde='${encodedDde}',ddh='${encodedDdh}',` +
      `ddps='${encodedDdps}',ddpv='${encodedDdpv}'`

    const peerData = this.getPeerService(span.context()._tags)
    if (peerData !== undefined && peerData[PEER_SERVICE_SOURCE_KEY] === PEER_SERVICE_KEY) {
      this.encodingServiceTags('ddprs', 'encodedDdprs', peerData[PEER_SERVICE_KEY])

      const { encodedDdprs } = this.serviceTags
      dbmComment += `,ddprs='${encodedDdprs}'`
    }
    return dbmComment
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

    const servicePropagation = this.createDBMPropagationCommentService(dbmService, span)

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

'use strict'

const { PEER_SERVICE_KEY, PEER_SERVICE_SOURCE_KEY } = require('../constants')
const propagationHash = require('../propagation-hash')
const StoragePlugin = require('./storage')

class DatabasePlugin extends StoragePlugin {
  static operation = 'query'
  static peerServicePrecursors = ['db.name']

  /**
   * @param {string} serviceName
   * @param {import('../../../..').Span} span
   * @param {object} peerData
   * @returns {string}
   */
  #createDBMPropagationCommentService (serviceName, span, peerData) {
    const spanTags = span.context()._tags
    const encodedDddb = encode(spanTags['db.name'])
    const encodedDddbs = encode(serviceName)
    const encodedDde = encode(this.tracer._env)
    const encodedDdh = encode(spanTags['out.host'])
    const encodedDdps = this.tracer._service ?? ''
    const encodedDdpv = this.tracer._version

    let dbmComment = `dddb='${encodedDddb}',dddbs='${encodedDddbs}',dde='${encodedDde}',ddh='${encodedDdh}',` +
      `ddps='${encodedDdps}',ddpv='${encodedDdpv}'`

    if (peerData !== undefined && peerData[PEER_SERVICE_SOURCE_KEY] === PEER_SERVICE_KEY) {
      dbmComment += `,ddprs='${encode(peerData[PEER_SERVICE_KEY])}'`
    }
    return dbmComment
  }

  /**
   * @param {string} tracerService
   * @param {object} peerData
   * @returns {string}
   */
  #getDbmServiceName (tracerService, peerData) {
    if (this._tracerConfig.spanComputePeerService) {
      return this.getPeerServiceRemap(peerData)[PEER_SERVICE_KEY] || tracerService
    }
    return tracerService
  }

  /**
   * @param {import('../../../..').Span} span
   * @param {string} serviceName
   * @param {boolean} disableFullMode
   */
  createDbmComment (span, serviceName, disableFullMode = false) {
    const mode = this.config.dbmPropagationMode

    if (mode === 'disabled') {
      return null
    }

    const peerData = this.getPeerService(span.context()._tags)
    const dbmService = this.#getDbmServiceName(serviceName, peerData)
    const servicePropagation = this.#createDBMPropagationCommentService(dbmService, span, peerData)

    let dbmComment = servicePropagation

    // Add propagation hash if both process tags and SQL base hash injection are enabled
    if (propagationHash.isEnabled() && this.config['dbm.injectSqlBaseHash']) {
      const hashBase64 = propagationHash.getHashBase64()
      if (hashBase64) {
        dbmComment += `,ddsh='${hashBase64}'`
        // Add hash to span meta as a tag
        span.setTag('_dd.dbm.propagation_hash', hashBase64)
      }
    }

    if (disableFullMode || mode === 'service') {
      return dbmComment
    } else if (mode === 'full') {
      span.setTag('_dd.dbm_trace_injected', 'true')
      span._processor.sample(span)
      const traceparent = span._spanContext.toTraceparent()
      return `${dbmComment},traceparent='${traceparent}'`
    }
  }

  /**
   * @param {import('../../../..').Span} span
   * @param {string} query
   * @param {string} serviceName
   * @param {boolean} disableFullMode
   * @returns {string}
   */
  injectDbmQuery (span, query, serviceName, disableFullMode = false) {
    const dbmTraceComment = this.createDbmComment(span, serviceName, disableFullMode)

    if (!dbmTraceComment) {
      return query
    }

    return this.config.appendComment
      ? `${query} /*${dbmTraceComment}*/`
      : `/*${dbmTraceComment}*/ ${query}`
  }

  /**
   * @param {string} query
   * @returns {string}
   */
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

const encode = value => value ? encodeURIComponent(value) : ''

module.exports = DatabasePlugin

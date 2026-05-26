'use strict'

const { LRUCache } = require('../../../../vendor/dist/lru-cache')
const { PEER_SERVICE_KEY, PEER_SERVICE_SOURCE_KEY } = require('../constants')
const propagationHash = require('../propagation-hash')
const StoragePlugin = require('./storage')

// Unreserved RFC 3986 set that `encodeURIComponent` leaves untouched (a conservative subset:
// `! * ' ( )` are also untouched but rarely appear in db / host / service names so we skip them).
const SAFE_ENCODE_RE = /^[\w\-.~]*$/

// Cap `#dbmPrefixCache` so a high-cardinality `db.name` (MongoDB sets it to
// `${database}.${collection}`) cannot grow the map without bound. Steady-state working sets
// fit well below the cap; cache misses cost a few hundred nanoseconds, so an evicted entry
// rebuilds cheaply on the next query.
const DBM_PREFIX_CACHE_MAX = 256

class DatabasePlugin extends StoragePlugin {
  static operation = 'query'
  static peerServicePrecursors = ['db.name']

  // dde / ddps / ddpv are tracer-process constants. They are baked in at `configure()` time as
  // two pre-templated fragments — `dbmEnvFragment` splices between dddbs and ddh; `dbmEndFragment`
  // trails ddh — so per-query work shrinks to encoding dddb / dddbs / ddh and concatenating.
  #dbmEnvFragment
  #dbmEndFragment
  // Cache the rendered prefix per `${db.name}\0${out.host}\0${dbmService}`. The triple is
  // connection-stable for a real workload, so the steady state is one `LRUCache.get` plus the
  // optional per-call `,ddprs='...'` suffix.
  #dbmPrefixCache = new LRUCache({ max: DBM_PREFIX_CACHE_MAX })

  /**
   * @override
   * @param {boolean | import('../config/config-base') & {enabled: boolean}} config
   */
  configure (config) {
    super.configure(config)
    // Match the previous shape exactly: `dde` is `encode`d; `ddps` / `ddpv` are template-literal
    // coerced so `undefined` renders as the literal `'undefined'` the way the original did.
    this.#dbmEnvFragment = `,dde='${encode(this.tracer._env)}',`
    this.#dbmEndFragment = `,ddps='${this.tracer._service ?? ''}',ddpv='${this.tracer._version}'`
    this.#dbmPrefixCache.clear()
  }

  /**
   * @param {string} serviceName
   * @param {import('../../../..').Span} span
   * @param {object} peerData
   * @returns {string}
   */
  #createDBMPropagationCommentService (serviceName, span, peerData) {
    const spanTags = span.context().getTags()
    const dddb = spanTags['db.name']
    const ddh = spanTags['out.host']
    const cacheKey = `${dddb ?? ''}\0${ddh ?? ''}\0${serviceName ?? ''}`

    let prefix = this.#dbmPrefixCache.get(cacheKey)
    if (prefix === undefined) {
      prefix = `dddb='${encode(dddb)}',dddbs='${encode(serviceName)}'${this.#dbmEnvFragment}` +
        `ddh='${encode(ddh)}'${this.#dbmEndFragment}`
      this.#dbmPrefixCache.set(cacheKey, prefix)
    }

    if (peerData !== undefined && peerData[PEER_SERVICE_SOURCE_KEY] === PEER_SERVICE_KEY) {
      return `${prefix},ddprs='${encode(peerData[PEER_SERVICE_KEY])}'`
    }
    return prefix
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

    const peerData = this.getPeerService(span.context().getTags())
    const dbmService = this.#getDbmServiceName(serviceName, peerData)
    const servicePropagation = this.#createDBMPropagationCommentService(dbmService, span, peerData)

    let dbmComment = servicePropagation

    // Add propagation hash if both process tags and SQL base hash injection are enabled
    if (propagationHash.isEnabled() && this.config['dbm.injectSqlBaseHash']) {
      const hashBase64 = propagationHash.getHashBase64()
      if (hashBase64) {
        dbmComment += `,ddsh='${hashBase64}'`
        // Add hash to span meta as a tag
        span.setTag('_dd.propagated_hash', hashBase64)
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

/**
 * @param {string | number | undefined | null} value
 * @returns {string}
 */
function encode (value) {
  if (!value) return ''
  return SAFE_ENCODE_RE.test(value) ? value : encodeURIComponent(value)
}

module.exports = DatabasePlugin

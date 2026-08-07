'use strict'

const { LRUCache } = require('../../../../../vendor/dist/lru-cache')
const { exitTags } = require('../../../../datadog-code-origin')
const { storage } = require('../../../../datadog-core')
const analyticsSampler = require('../../analytics_sampler')
const {
  CLIENT_PORT_KEY,
  COMPONENT,
  PEER_SERVICE_KEY,
  PEER_SERVICE_REMAP_KEY,
  PEER_SERVICE_SOURCE_KEY,
  SVC_SRC_KEY,
} = require('../../constants')
const propagationHash = require('../../propagation-hash')
const { INTEGRATION_SERVICE } = require('../../service-naming/source-resolver')
const { IS_SERVERLESS } = require('../../serverless')
const EventComponent = require('../component')
const channels = require('./channels')

const legacyStorage = storage('legacy')
const SAFE_ENCODE_RE = /^[\w\-.~]*$/
const DBM_PREFIX_CACHE_MAX = 256
const COMMON_PEER_SVC_SOURCE_TAGS = ['net.peer.name', 'out.host']

/**
 * Shared, plugin-independent processor for normalized database query events.
 */
class DatabaseQueryProcessor extends EventComponent {
  static eventOperation = 'db.query'

  /**
   * @param {object} tracer Public tracer proxy.
   * @param {object} tracerConfig Global tracer configuration.
   * @param {import('../registry').EventDomainRegistry} registry Event domain registry.
   */
  constructor (tracer, tracerConfig, registry) {
    super()
    this._tracer = tracer
    this._spanTracer = tracer?._tracer || tracer
    this._tracerConfig = tracerConfig
    this._registry = registry
    this._dbmEnvFragment = `,dde='${encode(this._spanTracer?._env)}',`
    this._dbmEndFragment =
      `,ddps='${this._spanTracer?._service ?? ''}',ddpv='${this._spanTracer?._version}'`
    this._dbmPrefixCache = new LRUCache({ max: DBM_PREFIX_CACHE_MAX })

    this.addBind(channels.queryStart, event => this.bindStart(event))
    this.addSub(channels.queryError, event => this.error(event))
    this.addSub(channels.queryFinish, event => this.finish(event))
  }

  /**
   * Start a database span using configuration owned by the package source.
   *
   * @param {object} event Normalized database query event.
   * @returns {object|undefined} Store containing the started span.
   */
  bindStart (event) {
    const data = event.data
    const source = event.source
    const runtime = this._registry.getSource(this.constructor.eventOperation, source.integration)
    if (!runtime) return event.parentStore

    const config = runtime.config
    const system = source.system
    const connection = data.connection
    let service = this.serviceName({
      pluginConfig: config,
      dbConfig: connection,
      system,
      id: source.integration,
    })
    if (!service?.name && system) {
      service = { name: `${this._spanTracer._service}-${system}`, source: system }
    }
    const span = this.startSpan(this.operationName({ id: source.integration }), {
      component: source.integration,
      integrationName: source.integration,
      service,
      resource: data.statement,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': system,
        'db.user': connection.user,
        'db.name': connection.database,
        'out.host': connection.host,
        [CLIENT_PORT_KEY]: connection.port,
      },
      config,
    }, event)

    data.statement = this.injectDbmQuery(span, data.statement, service.name, false, config)

    return event.currentStore
  }

  serviceName (options) {
    return this._tracer._nomenclature.serviceName('storage', 'client', options.id, options)
  }

  operationName (options) {
    return this._tracer._nomenclature.opName('storage', 'client', options.id, options)
  }

  startSpan (name, options, event) {
    const config = options.config
    const service = options.service
    const parentStore = legacyStorage.getStore()
    const childOf = parentStore?.span
    const serviceName = service?.name
    const serviceSource = serviceName && serviceName !== this._spanTracer._service
      ? service.source
      : undefined
    const span = this._spanTracer.startSpan(name, {
      childOf,
      tags: {
        [COMPONENT]: options.component,
        'service.name': serviceName || this._spanTracer._service,
        'resource.name': options.resource,
        'span.kind': options.kind,
        'span.type': options.type,
        ...(serviceSource === undefined ? undefined : { [SVC_SRC_KEY]: serviceSource }),
        ...options.meta,
      },
      integrationName: options.integrationName,
      links: childOf?._links,
    })

    if (serviceName !== undefined) span[INTEGRATION_SERVICE] = serviceName
    analyticsSampler.sample(span, config.measured)
    if (
      this._tracerConfig.codeOriginForSpans?.enabled &&
      this._tracerConfig.codeOriginForSpans.experimental?.exit_spans?.enabled
    ) {
      span.addTags(exitTags(this.startSpan))
    }

    event.parentStore = parentStore
    event.currentStore = { ...parentStore, span }

    return span
  }

  error (event) {
    event.currentStore?.span.setTag('error', event.error)
  }

  finish (event) {
    const span = event.currentStore?.span
    if (!span) return

    this.tagPeerService(span)
    if (IS_SERVERLESS) {
      const peerHostname = storage('peerServerless').getStore()?.peerHostname
      if (peerHostname) span.setTag('peer.service', peerHostname)
    }
    span.finish()
  }

  tagPeerService (span) {
    if (!this._tracerConfig.spanComputePeerService) return

    const tags = span.context().getTags()
    if (tags[PEER_SERVICE_SOURCE_KEY] !== undefined) return

    const peerData = this.getPeerService(tags)
    if (peerData !== undefined) span.addTags(this.getPeerServiceRemap(peerData))
  }

  getPeerService (tags) {
    if (tags[PEER_SERVICE_KEY] !== undefined) {
      return {
        [PEER_SERVICE_KEY]: tags[PEER_SERVICE_KEY],
        [PEER_SERVICE_SOURCE_KEY]: PEER_SERVICE_KEY,
      }
    }

    for (const sourceTag of ['db.name', ...COMMON_PEER_SVC_SOURCE_TAGS]) {
      if (tags[sourceTag]) {
        return {
          [PEER_SERVICE_KEY]: tags[sourceTag],
          [PEER_SERVICE_SOURCE_KEY]: sourceTag,
        }
      }
    }
  }

  getPeerServiceRemap (peerData) {
    const peerService = peerData[PEER_SERVICE_KEY]
    const mappedService = this._tracerConfig.peerServiceMapping?.[peerService]
    if (!peerService || !mappedService) return peerData

    return {
      ...peerData,
      [PEER_SERVICE_KEY]: mappedService,
      [PEER_SERVICE_REMAP_KEY]: peerService,
    }
  }

  createDbmComment (span, serviceName, disableFullMode, config) {
    const mode = config.dbmPropagationMode
    if (mode === 'disabled') return null

    const peerData = this.getPeerService(span.context().getTags())
    const dbmService = this._tracerConfig.spanComputePeerService && peerData
      ? this.getPeerServiceRemap(peerData)[PEER_SERVICE_KEY] || serviceName
      : serviceName
    const spanTags = span.context().getTags()
    const dddb = spanTags['db.name']
    const ddh = spanTags['out.host']
    const cacheKey = `${dddb ?? ''}\0${ddh ?? ''}\0${dbmService ?? ''}`
    let comment = this._dbmPrefixCache.get(cacheKey)

    if (comment === undefined) {
      comment = `dddb='${encode(dddb)}',dddbs='${encode(dbmService)}'${this._dbmEnvFragment}` +
        `ddh='${encode(ddh)}'${this._dbmEndFragment}`
      this._dbmPrefixCache.set(cacheKey, comment)
    }
    if (peerData?.[PEER_SERVICE_SOURCE_KEY] === PEER_SERVICE_KEY) {
      comment += `,ddprs='${encode(peerData[PEER_SERVICE_KEY])}'`
    }

    if (propagationHash.isEnabled() && (config['dbm.injectSqlBaseHash'] || mode === 'dynamic_service')) {
      const hashBase64 = propagationHash.getHashBase64()
      if (hashBase64) {
        comment += `,ddsh='${hashBase64}'`
        span.setTag('_dd.propagated_hash', hashBase64)
      }
    }

    if (disableFullMode || mode === 'service' || mode === 'dynamic_service') return comment
    if (mode === 'full') {
      span.setTag('_dd.dbm_trace_injected', 'true')
      span._processor.sample(span)
      return `${comment},traceparent='${span._spanContext.toTraceparent()}'`
    }
  }

  injectDbmQuery (span, query, serviceName, disableFullMode, config) {
    const comment = this.createDbmComment(span, serviceName, disableFullMode, config)
    if (!comment) return query

    return config.appendComment
      ? `${query} /*${comment}*/`
      : `/*${comment}*/ ${query}`
  }
}

function encode (value) {
  if (!value) return ''
  return SAFE_ENCODE_RE.test(value) ? value : encodeURIComponent(value)
}

module.exports = DatabaseQueryProcessor

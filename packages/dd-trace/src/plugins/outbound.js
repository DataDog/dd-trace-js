'use strict'

const {
  CLIENT_PORT_KEY,
  PEER_SERVICE_SOURCE_KEY,
} = require('../constants')
const { exitTags } = require('../../../datadog-code-origin')
const { storage } = require('../../../datadog-core')
const { IS_SERVERLESS } = require('../serverless')
const TracingPlugin = require('./tracing')
const { getPeerService, remapPeerService } = require('./util/peer-service')

// TODO: Exit span on finish when AsyncResource instances are removed.
class OutboundPlugin extends TracingPlugin {
  /**
   *
   * @type {string[]}
   */
  static peerServicePrecursors = []

  constructor (...args) {
    super(...args)

    this.addTraceSub('connect', ctx => {
      this.connect(ctx)
    })
  }

  /**
   * @param {{ parentStore?: { span: import('../../../..').Span } }} ctx
   */
  bindFinish (ctx) {
    return ctx.parentStore
  }

  startSpan (name, options, enterOrCtx) {
    const span = super.startSpan(name, options, enterOrCtx)
    if (
      this._tracerConfig.codeOriginForSpans.enabled &&
      this._tracerConfig.codeOriginForSpans.experimental.exit_spans.enabled
    ) {
      span.addTags(exitTags(this.startSpan))
    }
    return span
  }

  /**
   * @param {Record<string, string>} tags
   */
  getPeerService (tags) {
    /**
     * Compute `peer.service` and associated metadata from available tags, based
     * on defined precursor tags names.
     *
     * - The `peer.service` tag is set from the first precursor available (based on list ordering)
     * - The `_dd.peer.service.source` tag is set from the precursor's name
     * - If `peer.service` was defined _before_ we compute it (for example in custom instrumentation),
     *   `_dd.peer.service.source`'s value is `peer.service`
     */
    return getPeerService(tags, this.constructor.peerServicePrecursors)
  }

  /**
   * @param {Record<string, string>} peerData
   */
  getPeerServiceRemap (peerData) {
    /**
     * If DD_TRACE_PEER_SERVICE_MAPPING is matched, we need to override the existing
     * peer service and add the value we overrode.
     */
    return remapPeerService(peerData, this._tracerConfig.peerServiceMapping)
  }

  /**
   * @param {{ currentStore?: { span: import('../../../..').Span } }} ctx
   */
  finish (ctx) {
    const span = ctx?.currentStore?.span || this.activeSpan
    this.tagPeerService(span)

    if (IS_SERVERLESS) {
      const peerHostname = storage('peerServerless').getStore()?.peerHostname
      if (peerHostname) span.setTag('peer.service', peerHostname)
    }

    super.finish(...arguments)
  }

  /**
   * @param {import('../../../..').Span} span
   */
  tagPeerService (span) {
    if (this._tracerConfig.spanComputePeerService) {
      const tags = span.context().getTags()
      if (tags[PEER_SERVICE_SOURCE_KEY] !== undefined) return

      const peerData = this.getPeerService(tags)
      if (peerData !== undefined) {
        span.addTags(this.getPeerServiceRemap(peerData))
      }
    }
  }

  /**
   * @param {object} ctx
   */
  connect (ctx) {
    this.addHost(ctx)
  }

  /**
   * @param {{ hostname: string, port: number, currentStore?: { span: import('../../../..').Span } }} ctx
   */
  addHost (ctx) {
    const { hostname, port } = ctx

    const span = ctx?.currentStore?.span || this.activeSpan

    if (!span) return

    span.addTags({
      'out.host': hostname,
      [CLIENT_PORT_KEY]: port,
    })
  }
}

module.exports = OutboundPlugin

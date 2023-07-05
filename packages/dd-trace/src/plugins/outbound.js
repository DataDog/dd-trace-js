'use strict'

const {
  CLIENT_PORT_KEY,
  PEER_SERVICE_KEY,
  PEER_SERVICE_SOURCE_KEY
} = require('../constants')
const TracingPlugin = require('./tracing')

const COMMON_PEER_SVC_SOURCE_TAGS = [
  'net.peer.name',
  'out.host'
]

// TODO: Exit span on finish when AsyncResource instances are removed.
class OutboundPlugin extends TracingPlugin {
  static get peerServicePrecursors () { return [] }

  constructor (...args) {
    super(...args)

    this.addTraceSub('connect', message => {
      this.connect(message)
    })
  }

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

    if (tags['peer.service'] !== undefined) {
      return { [PEER_SERVICE_SOURCE_KEY]: 'peer.service' }
    }

    const sourceTags = [
      ...this.constructor.peerServicePrecursors,
      ...COMMON_PEER_SVC_SOURCE_TAGS
    ]

    for (const sourceTag of sourceTags) {
      if (tags[sourceTag]) {
        return {
          [PEER_SERVICE_KEY]: tags[sourceTag],
          [PEER_SERVICE_SOURCE_KEY]: sourceTag
        }
      }
    }
    return {}
  }

  startSpan (name, options) {
    const span = super.startSpan(name, options)
    return span
  }

  finish () {
    const span = this.activeSpan
    this.tagPeerService(span)
    super.finish(...arguments)
  }

  tagPeerService (span) {
    if (this.tracer._computePeerService) {
      const peerData = this.getPeerService(span.context()._tags)
      if (peerData) {
        span.addTags(peerData)
      }
    }
  }

  connect (url) {
    this.addHost(url.hostname, url.port)
  }

  addHost (hostname, port) {
    const span = this.activeSpan

    if (!span) return

    span.addTags({
      'out.host': hostname,
      [CLIENT_PORT_KEY]: port
    })
  }
}

module.exports = OutboundPlugin

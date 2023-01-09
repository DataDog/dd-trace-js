'use strict'

const TracingPlugin = require('./tracing')
const { resolveHostDetails } = require('../util')

// const transportProtocols = ['ip_tcp', 'ip_udp', 'unix', 'pipe', 'inproc', 'other']

// TODO: Exit span on finish when AsyncResource instances are removed.
class OutgoingPlugin extends TracingPlugin {
  constructor (...args) {
    super(...args)

    this.addTraceSub('connect', message => {
      this.connect(message)
    })
  }

  connect (url) {
    this.addHost(url.hostname, url.port)
  }

  addHost (hostname, port) {
    const span = this.activeSpan

    if (!span) return

    const hostDetails = resolveHostDetails(hostname)

    span.addTags({
      ...hostDetails,
      'network.destination.port': port
    })
  }
}

module.exports = OutgoingPlugin

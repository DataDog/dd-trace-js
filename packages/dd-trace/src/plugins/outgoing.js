'use strict'

const TracingPlugin = require('./tracing')

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

    span.addTags({
      'out.host': hostname,
      'network.destination.port': port
    })
  }
}

module.exports = OutgoingPlugin

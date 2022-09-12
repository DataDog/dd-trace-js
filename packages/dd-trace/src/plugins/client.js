'use strict'

const TracingPlugin = require('./tracing')

// TODO: Add system property for the service name of databases and caches.
// TODO: Exit span on finish when AsyncResource instances are removed.
class ClientPlugin extends TracingPlugin {
  constructor (...args) {
    super(...args)

    this.addTraceSub('connect', message => {
      this.connect(message)
    })
  }

  connect (url) {
    this.addOutgoingHost(url.hostname, url.port)
  }

  addOutgoingHost (hostname, port) {
    this.activeSpan().addTags({
      'out.host': hostname,
      'out.port': port
    })
  }
}

module.exports = ClientPlugin

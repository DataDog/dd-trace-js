'use strict'

const TracingPlugin = require('./tracing')

// TODO: Exit span on finish when AsyncResource instances are removed.
class ClientPlugin extends TracingPlugin {
  constructor (...args) {
    super(...args)

    this.addSub(`${this.prefix}:connect`, message => {
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

'use strict'

const { CLIENT_PORT_KEY } = require('../constants')
const TracingPlugin = require('./tracing')

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

  asyncEnd (...args) {
    super.asyncEnd(...args)
    this.exit(...args)
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

module.exports = OutgoingPlugin

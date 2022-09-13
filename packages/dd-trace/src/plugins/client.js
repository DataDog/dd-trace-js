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

  startSpan (name, options) {
    if (!options.service && this.system) {
      options.service = `${this.tracer._service}-${this.system}`
    }

    return super.startSpan(name, options)
  }

  addOutgoingHost (hostname, port) {
    const span = this.activeSpan()

    if (!span) return

    span.addTags({
      'out.host': hostname,
      'out.port': port
    })
  }
}

module.exports = ClientPlugin

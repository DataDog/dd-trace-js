'use strict'

const DNSPlugin = require('./dns')

class DNSLookupPlugin extends DNSPlugin {
  static operation = 'lookup'

  extendEvent (event, startEvent) {
    event.name = 'lookup'
    event.detail = { hostname: startEvent.args[0] }

    return event
  }
}

module.exports = DNSLookupPlugin

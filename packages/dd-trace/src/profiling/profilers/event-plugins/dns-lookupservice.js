'use strict'

const DNSPlugin = require('./dns')

class DNSLookupServicePlugin extends DNSPlugin {
  static operation = 'lookup_service'

  extendEvent (event, startEvent) {
    event.name = 'lookupService'
    event.detail = { host: startEvent.args[0], port: startEvent.args[1] }

    return event
  }
}

module.exports = DNSLookupServicePlugin

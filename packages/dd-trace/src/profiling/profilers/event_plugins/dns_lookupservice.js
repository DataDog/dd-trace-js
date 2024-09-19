const DNSPlugin = require('./dns')

class DNSLookupServicePlugin extends DNSPlugin {
  static get operation () {
    return 'lookup_service'
  }

  extendEvent (event, startEvent) {
    event.name = 'lookupService'
    event.detail = { host: startEvent[0], port: startEvent[1] }

    return event
  }
}

module.exports = DNSLookupServicePlugin

const DNSPlugin = require('./dns')

class DNSLookupPlugin extends DNSPlugin {
  static get operation () {
    return 'lookup'
  }

  extendEvent (event, startEvent) {
    event.name = 'lookup'
    event.detail = { hostname: startEvent[0] }

    return event
  }
}

module.exports = DNSLookupPlugin

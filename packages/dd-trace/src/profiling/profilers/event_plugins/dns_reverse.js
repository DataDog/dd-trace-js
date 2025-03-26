const DNSPlugin = require('./dns')

class DNSReversePlugin extends DNSPlugin {
  static get operation () {
    return 'reverse'
  }

  extendEvent (event, startEvent) {
    event.name = 'getHostByAddr'
    event.detail = { host: startEvent[0] }

    return event
  }
}

module.exports = DNSReversePlugin

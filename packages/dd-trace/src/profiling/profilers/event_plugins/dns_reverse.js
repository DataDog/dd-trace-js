'use strict'

const DNSPlugin = require('./dns')

class DNSReversePlugin extends DNSPlugin {
  static operation = 'reverse'

  extendEvent (event, startEvent) {
    event.name = 'getHostByAddr'
    event.detail = { host: startEvent.args[0] }

    return event
  }
}

module.exports = DNSReversePlugin

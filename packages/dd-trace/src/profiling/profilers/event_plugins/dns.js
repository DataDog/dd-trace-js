const EventPlugin = require('./event')

class DNSPlugin extends EventPlugin {
  static get id () {
    return 'dns'
  }

  static get entryType () {
    return 'dns'
  }
}

module.exports = DNSPlugin

'use strict'

const EventPlugin = require('./event')

class DNSPlugin extends EventPlugin {
  static id = 'dns'

  static entryType = 'dns'
}

module.exports = DNSPlugin

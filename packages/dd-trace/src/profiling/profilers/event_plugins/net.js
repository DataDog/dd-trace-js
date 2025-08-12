'use strict'

const EventPlugin = require('./event')

class NetPlugin extends EventPlugin {
  static id = 'net'

  static operation = 'tcp'

  static entryType = 'net'

  extendEvent (event, { options }) {
    event.name = 'connect'
    event.detail = options

    return event
  }
}

module.exports = NetPlugin

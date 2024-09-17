const EventPlugin = require('./event')

class NetPlugin extends EventPlugin {
  static get id () {
    return 'net'
  }

  static get operation () {
    return 'tcp'
  }

  static get entryType () {
    return 'net'
  }

  extendEvent (event, { options }) {
    event.name = 'connect'
    event.detail = options

    return event
  }
}

module.exports = NetPlugin

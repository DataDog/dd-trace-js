const EventPlugin = require('./event')

class CryptoPlugin extends EventPlugin {
  static get id () {
    return 'crypto'
  }

  static get operation () {
    return 'operation'
  }

  static get entryType () {
    return 'crypto'
  }

  extendEvent (event, detail) {
    // pass through, we'll reconstruct in the decorator
    event.detail = detail
    return event
  }
}
module.exports = CryptoPlugin

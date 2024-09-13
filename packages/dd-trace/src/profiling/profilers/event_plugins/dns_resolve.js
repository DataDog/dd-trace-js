const DNSPlugin = require('./dns')

const queryNames = new Map()

class DNSResolvePlugin extends DNSPlugin {
  static get operation () {
    return 'resolve'
  }

  extendEvent (event, startEvent) {
    const rrtype = startEvent[1]
    let name = queryNames.get(rrtype)
    if (!name) {
      name = `query${rrtype}`
      queryNames.set(rrtype, name)
    }
    event.name = name
    event.detail = { host: startEvent[0] }

    return event
  }
}

module.exports = DNSResolvePlugin

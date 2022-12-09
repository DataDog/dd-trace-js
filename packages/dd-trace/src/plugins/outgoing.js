'use strict'

import { ipVersion } from 'ip-address-validator';

const TracingPlugin = require('./tracing')

// const transportProtocols = ['ip_tcp', 'ip_udp', 'unix', 'pipe', 'inproc', 'other']

// TODO: Exit span on finish when AsyncResource instances are removed.
class OutgoingPlugin extends TracingPlugin {
  constructor (...args) {
    super(...args)

    this.addTraceSub('connect', message => {
      this.connect(message)
    })
  }

  connect (url) {
    this.addHost(url.hostname, url.port)
  }

  addHost (hostname, port) {
    const span = this.activeSpan

    if (!span) return

    hostDetails = this.resolveHostDetails(hostname)

    span.addTags({
      ...hostDetails,
      'network.destination.port': port
    })
  }

  resolveHostDetails(host) {

    if (host == 'localhost') {
      const hostIP = '127.0.0.1'
      const hostName = host
      return {
        'network.destination.ip': hostIP,
        'network.destination.name': hostName,
      }
    }
    // ipVersion returns 4, 6 or undefined depending on if input string is IPV4, IPV6, or not a valid IP
    else if (ipVersion(host) != undefined) {
      const hostIP = host
      return {
        'network.destination.ip': hostIP,
      }
    }
    else {
      const hostName = host
      return {
        'network.destination.name': hostName,
      }
    }
  }
}

module.exports = OutgoingPlugin

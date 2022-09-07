'use strict'

const semver = require('semver')

if (semver.satisfies(process.version, '>=14.18.0')) {
  const net = require('net')

  module.exports = net.BlockList
} else {
  const ipaddr = require('ipaddr.js')

  module.exports = class BlockList {
    constructor () {
      this.v4Ranges = []
      this.v6Ranges = []
    }

    addSubnet (net, prefix, type) {
      this[type === 'ipv4' ? 'v4Ranges' : 'v6Ranges'].push(ipaddr.parseCIDR(`${net}/${prefix}`))
    }

    check (address, type) {
      try {
        const ip = ipaddr.process(address)

        if (type === 'ipv4' || ip.isIPv4MappedAddress()) {
          for (const range of this.v4Ranges) {
            if (ip.match(range)) return true
          }
        }

        if (type === 'ipv6') {
          for (const range of this.v6Ranges) {
            if (ip.match(range)) return true
          }
        }

        return false
      } catch {
        return false
      }
    }
  }
}

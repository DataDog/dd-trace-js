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
        let ip = ipaddr.parse(address)

        type = ip.kind()

        if (type === 'ipv6') {
          for (const range of this.v6Ranges) {
            if (ip.match(range)) return true
          }

          if (ip.isIPv4MappedAddress()) {
            ip = ip.toIPv4Address()
            type = ip.kind()
          }
        }

        if (type === 'ipv4') {
          for (const range of this.v4Ranges) {
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

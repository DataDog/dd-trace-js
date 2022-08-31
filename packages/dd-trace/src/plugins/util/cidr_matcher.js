'use strict'

const semver = require('semver')

if (semver.satisfies(process.version, '>=14.18.0')) {
  const net = require('net')

  module.exports = class CIDRMatcher {
    constructor (cidrs) {
      this.matcher = new net.BlockList()

      for (const cidr of cidrs) {
        const [ address, prefix ] = cidr.split('/')
        
        this.matcher.addSubnet(address, parseInt(prefix), net.isIPv6(address) ? 'ipv6' : 'ipv4')
      }
    }

    contains (ip) {
      this.matcher.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4')
    }
  }
} else {
  module.exports = require('cidr-matcher')
}
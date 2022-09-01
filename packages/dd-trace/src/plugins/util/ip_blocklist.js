'use strict'

const semver = require('semver')

if (semver.satisfies(process.version, '>=14.18.0')) {
  const net = require('net')

  module.exports = net.BlockList
} else {
  const CIDRMatcher = require('cidr-matcher')

  module.exports = class BlockList {
    constructor () {
      this.matcher = new CIDRMatcher()
    }

    addSubnet (net, prefix, type) {
      this.matcher.addNetworkClass(`${net}/${prefix}`)
    }

    check (address, type) {
      this.matcher.contains(address)
    }
  }
}

'use strict'

const BlockList = require('./ip_blocklist')
const net = require('net')
const log = require('../../log')

const ipHeaderList = [
  'x-forwarded-for',
  'x-real-ip',
  'client-ip',
  'x-forwarded',
  'x-cluster-client-ip',
  'forwarded-for',
  'forwarded',
  'via',
  'true-client-ip'
]

const privateCIDRs = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fec0::/10',
  'fe80::/10',
  'fc00::/7',
  'fd00::/8'
]

const privateIPMatcher = new BlockList()

for (const cidr of privateCIDRs) {
  const [address, prefix] = cidr.split('/')

  privateIPMatcher.addSubnet(address, parseInt(prefix), net.isIPv6(address) ? 'ipv6' : 'ipv4')
}

function extractIp (config, req) {
  const headers = req.headers
  if (config.clientIpHeader) {
    if (!headers) return
    const header = headers[config.clientIpHeader]
    if (!header) return

    return findFirstIp(header)
  }

  const foundHeaders = []
  if (headers) {
    for (let i = 0; i < ipHeaderList.length; i++) {
      if (headers[ipHeaderList[i]]) {
        foundHeaders.push(ipHeaderList[i])
      }
    }
  }

  if (foundHeaders.length === 1) {
    const header = headers[foundHeaders[0]]
    const firstIp = findFirstIp(header)

    if (firstIp) return firstIp
  } else if (foundHeaders.length > 1) {
    log.error(`Cannot find client IP: multiple IP headers detected ${foundHeaders}`)
    return
  }

  return req.socket && req.socket.remoteAddress
}

function findFirstIp (str) {
  let firstPrivateIp
  const splitted = str.split(',')

  for (let i = 0; i < splitted.length; i++) {
    const chunk = splitted[i].trim()

    // TODO: strip port and interface data ?

    const type = net.isIP(chunk)
    if (!type) continue

    if (!privateIPMatcher.check(chunk, type === 6 ? 'ipv6' : 'ipv4')) {
      // it's public, return it immediately
      return chunk
    }

    // it's private, only save the first one found
    if (!firstPrivateIp) firstPrivateIp = chunk
  }

  return firstPrivateIp
}

module.exports = {
  extractIp
}

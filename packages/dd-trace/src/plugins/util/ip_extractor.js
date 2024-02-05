'use strict'

const { BlockList } = require('net')
const net = require('net')

const ipHeaderList = [
  'x-forwarded-for',
  'x-real-ip',
  'true-client-ip',
  'x-client-ip',
  'x-forwarded',
  'forwarded-for',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'cf-connecting-ip',
  'cf-connecting-ipv6'
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

    const ip = findFirstIp(headers[config.clientIpHeader])
    return ip.public || ip.private
  }

  let firstPrivateIp
  if (headers) {
    for (const ipHeaderName of ipHeaderList) {
      const firstIp = findFirstIp(headers[ipHeaderName])

      if (firstIp.public) {
        return firstIp.public
      } else if (!firstPrivateIp && firstIp.private) {
        firstPrivateIp = firstIp.private
      }
    }
  }

  return firstPrivateIp || req.socket?.remoteAddress
}

function findFirstIp (str) {
  const result = {}
  if (!str) return result

  const splitted = str.split(',')

  for (const part of splitted) {
    const chunk = part.trim()

    // TODO: strip port and interface data ?

    const type = net.isIP(chunk)
    if (!type) continue

    if (!privateIPMatcher.check(chunk, type === 6 ? 'ipv6' : 'ipv4')) {
      // it's public, return it immediately
      result.public = chunk
      break
    }

    // it's private, only save the first one found
    if (!result.private) result.private = chunk
  }

  return result
}

module.exports = {
  extractIp,
  ipHeaderList
}

'use strict'

const net = require('net')

const FORWARED_HEADER_NAME = 'forwarded'

const ipHeaderList = [
  'x-forwarded-for',
  'x-real-ip',
  'true-client-ip',
  'x-client-ip',
  FORWARED_HEADER_NAME,
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
  '100.65.0.0/10',
  '::1/128',
  'fec0::/10',
  'fe80::/10',
  'fc00::/7',
  'fd00::/8'
]

const privateIPMatcher = new net.BlockList()

for (const cidr of privateCIDRs) {
  const [address, prefix] = cidr.split('/')

  privateIPMatcher.addSubnet(address, Number.parseInt(prefix), net.isIPv6(address) ? 'ipv6' : 'ipv4')
}

function extractIp (config, req) {
  const headers = req.headers
  if (config.clientIpHeader) {
    if (!headers) return

    const ipHeaderName = config.clientIpHeader
    const header = headers[ipHeaderName]
    if (typeof header !== 'string') return

    const ip = findFirstIp(header, ipHeaderName === FORWARED_HEADER_NAME)
    return ip.public || ip.private
  }

  let firstPrivateIp
  if (headers) {
    for (const ipHeaderName of ipHeaderList) {
      const header = headers[ipHeaderName]
      if (typeof header !== 'string') continue

      const ip = findFirstIp(header, ipHeaderName === FORWARED_HEADER_NAME)

      if (ip.public) {
        return ip.public
      } else if (!firstPrivateIp && ip.private) {
        firstPrivateIp = ip.private
      }
    }
  }

  return firstPrivateIp || req.socket?.remoteAddress
}

function findFirstIp (str, isForwardedHeader) {
  const result = {}
  if (!str) return result

  const splitted = str.split(',')

  for (let chunk of splitted) {
    if (isForwardedHeader) {
      // find "for" directive
      const forDirective = chunk.split(';').find(subchunk => subchunk.trim().toLowerCase().startsWith('for='))

      // if found remove the "for=" prefix
      // else keep going as is
      if (forDirective) {
        chunk = forDirective.slice(4)
      }
    }

    chunk = chunk.trim()

    // trim potential double quotes
    if (chunk.startsWith('"') && chunk.endsWith('"')) {
      chunk = chunk.slice(1, -1).trim()
    }

    // TODO: when min node support is v24 we can instead use net.SocketAddress.parse()
    chunk = cleanIp(chunk)
    if (!chunk) continue

    const type = net.isIP(chunk)
    if (!type) continue

    if (!privateIPMatcher.check(chunk, type === 6 ? 'ipv6' : 'ipv4')) {
      // it's public, return it immediately
      result.public = chunk
      return result
    }

    // it's private, only save the first one found
    if (!result.private) result.private = chunk
  }

  return result
}

function cleanIp (input) {
  const colonIndex = input.indexOf(':')
  if (colonIndex !== -1 && input.includes('.')) {
    // treat it as ipv4 with port
    return input.slice(0, colonIndex).trim()
  }

  const closingBracketIndex = input.indexOf(']')
  if (closingBracketIndex !== -1 && input.startsWith('[')) {
    // treat as ipv6 with brackets
    return input.slice(1, closingBracketIndex).trim()
  }

  // no need to clean it
  return input
}

module.exports = {
  extractIp,
  ipHeaderList
}

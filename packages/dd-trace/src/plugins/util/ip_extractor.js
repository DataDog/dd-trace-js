'use strict'

const { BlockList } = require('net')
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

const privateIPMatcher = new BlockList()

for (const cidr of privateCIDRs) {
  const [address, prefix] = cidr.split('/')

  privateIPMatcher.addSubnet(address, Number.parseInt(prefix), net.isIPv6(address) ? 'ipv6' : 'ipv4')
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
      const header = headers[ipHeaderName]
      const firstIp = ipHeaderName === FORWARED_HEADER_NAME ? findFirstIpForwardedFormat(header) : findFirstIp(header)

      if (firstIp.public) {
        return firstIp.public
      } else if (!firstPrivateIp && firstIp.private) {
        firstPrivateIp = firstIp.private
      }
    }
  }

  return firstPrivateIp || req.socket?.remoteAddress
}

function isPublicIp (ip, type) {
  return !privateIPMatcher.check(ip, type === 6 ? 'ipv6' : 'ipv4')
}

function extractPublicOrPrivateIp (ip) {
  const type = net.isIP(ip)
  if (!type) return {}

  if (isPublicIp(ip, type)) {
    return { public: true }
  }

  return { private: true }
}

function findFirstIp (str) {
  const result = {}
  if (!str) return result

  const splitted = str.split(',')

  for (const part of splitted) {
    const chunk = part.trim()

    // TODO: strip port and interface data ?

    const currentIpInfo = extractPublicOrPrivateIp(chunk)
    if (currentIpInfo.public) {
      // it's public, return it immediately
      result.public = chunk
      break
    }

    // it's private, only save the first one found
    if (currentIpInfo.private && !result.private) result.private = chunk
  }

  return result
}

const forwardedForRegexp = /for="?\[?(([0-9]+\.)+[0-9]+|[0-9a-f:]*:[0-9a-f]*)/i
const forwardedByRegexp = /by="?\[?(([0-9]+\.)+[0-9]+|[0-9a-f:]*:[0-9a-f]*)/i
const forwardedRegexps = [forwardedForRegexp, forwardedByRegexp]

function findFirstIpForwardedFormat (str) {
  const result = {}
  if (!str) return result

  const splitted = str.split(',')

  for (const part of splitted) {
    const chunk = part.trim()

    for (const regex of forwardedRegexps) {
      const ip = regex.exec(chunk)?.[1]

      const tempResult = extractPublicOrPrivateIp(ip)
      if (tempResult.public) {
        // it's public, return it immediately
        result.public = ip
        break
      }

      // it's private, only save the first one found
      if (tempResult.private && !result.private) result.private = ip
    }

    if (result.public) break
  }

  return result
}

module.exports = {
  extractIp,
  ipHeaderList
}

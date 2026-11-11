'use strict'

const { isIPv6 } = require('node:net')

// Port of the Agent's `obfuscate.QuantizePeerIPAddresses`, which it applies to peer tag values when it computes
// stats itself. Client-computed stats reach the Agent already aggregated, so the tracer has to apply it.
// https://github.com/DataDog/datadog-agent/blob/main/pkg/obfuscate/ip_address.go

const BLOCKED_IP_ADDRESS = 'blocked-ip-address'

const SCHEMES = ['dnspoll', 'ftp', 'file', 'http', 'https']

const ALLOWED_IP_ADDRESSES = new Set([
  // localhost
  '127.0.0.1',
  '::1',
  // link-local cloud provider metadata server addresses
  '169.254.169.254',
  'fd00:ec2::254',
  // ECS task metadata
  '169.254.170.2',
])

/**
 * Replace every IP address in a comma-separated host list, keeping ports, schemes and surrounding host name parts,
 * and collapse the entries that become identical. Entries without an IP address are kept unchanged.
 *
 * @param {string} raw
 */
function quantizePeerIpAddresses (raw) {
  if (!raw.includes(',')) return quantizeIp(raw)

  const unique = new Set()
  for (const value of raw.split(',')) {
    unique.add(quantizeIp(value))
  }
  return [...unique].join(',')
}

/**
 * @param {string} raw
 */
function quantizeIp (raw) {
  const prefixLength = getPrefixLength(raw)
  const hostPort = prefixLength === 0 ? raw : raw.slice(prefixLength)

  let host = hostPort
  let port = ''
  const portSeparator = getPortSeparatorIndex(hostPort)
  if (portSeparator !== -1) {
    host = hostPort[0] === '[' ? hostPort.slice(1, portSeparator - 1) : hostPort.slice(0, portSeparator)
    port = hostPort.slice(portSeparator + 1)
  }

  const ipEnd = getIpEnd(host)
  if (ipEnd === -1 || ALLOWED_IP_ADDRESSES.has(host.slice(0, ipEnd))) return raw

  let replacement = raw.slice(0, prefixLength) + BLOCKED_IP_ADDRESS
  if (port) {
    // Ports have a far lower cardinality than addresses and usually identify the protocol.
    replacement += `:${port}`
  }
  return replacement + host.slice(ipEnd)
}

/**
 * Length of an `ip-` (EC2 host name) or `<scheme>://` prefix, else 0.
 *
 * @param {string} raw
 */
function getPrefixLength (raw) {
  if (raw.startsWith('ip-')) return 3

  for (const scheme of SCHEMES) {
    if (!raw.startsWith(scheme)) continue
    if (raw.length > scheme.length + 4 && raw.startsWith(':///', scheme.length)) return scheme.length + 4
    if (raw.length > scheme.length + 3 && raw.startsWith('://', scheme.length)) return scheme.length + 3
  }
  return 0
}

/**
 * Locate the port separator of `host:port`, `host%zone:port`, `[host]:port` or `[host%zone]:port`, following
 * `net.SplitHostPort`: the index of the colon before the port, or -1 when there is no valid one.
 *
 * @param {string} hostPort
 */
function getPortSeparatorIndex (hostPort) {
  const separator = hostPort.lastIndexOf(':')
  if (separator === -1) return -1

  // Positions before which a '[' or ']' is part of the host syntax.
  let openingEnd = 0
  let closingEnd = 0
  if (hostPort[0] === '[') {
    // The first ']' has to come right before the last ':'.
    const closing = hostPort.indexOf(']')
    if (closing + 1 !== separator) return -1
    openingEnd = 1
    closingEnd = separator
  } else if (separator > 0 && hostPort.lastIndexOf(':', separator - 1) !== -1) {
    return -1
  }

  if (hostPort.includes('[', openingEnd) || hostPort.includes(']', closingEnd)) return -1
  return separator
}

/**
 * End index of the IP address `value` starts with, or -1 when it does not start with one.
 *
 * @param {string} value
 */
function getIpEnd (value) {
  if (value.length === 0 || !isIpStart(value.charCodeAt(0))) return -1

  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '.' || char === '_' || char === '-') return getIpv4End(value, char)
    if (char === ':') return isIPv6(value) ? value.length : -1
    // An IPv6 zone specifier without an address.
    if (char === '%') return -1
  }
  return -1
}

/**
 * Whether `code` is a hex digit or ':', the characters an IP address can start with.
 *
 * @param {number} code
 */
function isIpStart (code) {
  return (code >= 48 && code <= 57) || // 0-9
    (code >= 97 && code <= 102) || // a-f
    (code >= 65 && code <= 70) || // A-F
    code === 58 // :
}

/**
 * Parse an IPv4 address using `separator` between its octets, allowing trailing characters: the end index of the
 * address, or -1 when `value` does not start with one.
 *
 * @param {string} value
 * @param {string} separator
 */
function getIpv4End (value, separator) {
  let octet = 0
  let octetIndex = 0
  let digits = 0
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char >= '0' && char <= '9') {
      if (digits === 1 && octet === 0) return -1
      octet = octet * 10 + (value.charCodeAt(i) - 48)
      digits++
      if (octet > 255) return -1
    } else if (char === separator) {
      if (i === 0 || i === value.length - 1 || value[i - 1] === separator) return -1
      if (octetIndex === 3) return i
      octetIndex++
      octet = 0
      digits = 0
    } else {
      return octetIndex === 3 && digits > 0 ? i : -1
    }
  }
  return octetIndex < 3 ? -1 : value.length
}

module.exports = { quantizePeerIpAddresses }

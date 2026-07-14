'use strict'

const net = require('node:net')

const { urlToHttpOptions } = require('./url-to-http-options-polyfill')

/**
 * @param {string} hostname
 */
function isLoopbackHost (hostname) {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname

  // Require an IPv4 literal so a hostname such as `127.example.com` does not count as loopback.
  return normalized === 'localhost' ||
    normalized === '::1' ||
    (normalized.startsWith('127.') && net.isIPv4(normalized))
}

/**
 * Convert an agent/intake URL into Node http(s) request options.
 *
 * A Windows named pipe (`unix://./pipe/<name>`) parses the `.` as the URL
 * authority, dropping it from the path. Fold it back so the socket path stays
 * `//./pipe/<name>`; otherwise it collapses to `/pipe/<name>` and misses the
 * pipe. Exporters receive `config.url` as a URL object, so this must run for
 * both string and object input.
 *
 * @param {string|URL|object} urlObjOrString
 * @returns {object}
 */
function parseUrl (urlObjOrString) {
  // `urlToHttpOptions` returns `pathname` at runtime, but @types/node narrows it
  // to `ClientRequestArgs`, which omits it; cast so the named-pipe fold below can
  // read and rewrite it.
  const url = /** @type {import('node:http').ClientRequestArgs & { pathname: string }} */ (
    urlObjOrString !== null && typeof urlObjOrString === 'object'
      ? urlToHttpOptions(urlObjOrString)
      : urlToHttpOptions(new URL(urlObjOrString))
  )

  if (url.protocol === 'unix:' && url.hostname === '.') {
    url.path = url.pathname = `//.${url.pathname}`
  }

  return url
}

module.exports = { isLoopbackHost, parseUrl }

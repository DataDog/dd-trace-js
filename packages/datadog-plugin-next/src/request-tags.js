'use strict'

const { NETWORK_PEER_ADDRESS } = require('../../dd-trace/src/plugins/util/http-otel-semantics')
const { extractURL, obfuscateQs } = require('../../dd-trace/src/plugins/util/url')

/**
 * @param {import('node:http').IncomingMessage | Request} req
 * @returns {req is Request}
 */
function isWebRequest (req) {
  return 'get' in req.headers && typeof req.headers.get === 'function'
}

/**
 * Capture request data that Next.js does not publish through web.addRequestTags.
 *
 * @param {{ setTag: (key: string, value: unknown) => void }} span
 * @param {Record<string, unknown>} config
 * @param {import('node:http').IncomingMessage | Request} req
 * @returns {void}
 */
function addOtelRequestTags (span, config, req) {
  if (!config.DD_TRACE_OTEL_SEMANTICS_ENABLED || !req.headers) return

  let url
  let userAgent
  let peerAddress
  if (isWebRequest(req)) {
    url = req.url
    userAgent = req.headers.get('user-agent') ?? undefined
  } else {
    url = extractURL(req)
    userAgent = req.headers['user-agent']
    peerAddress = req.socket?.remoteAddress
  }

  span.setTag('http.url', obfuscateQs(config, url))
  // `web.addRequestTags` records this on the shared path; without it the conversion has no
  // `user_agent.original` to emit.
  if (userAgent !== undefined) span.setTag('http.useragent', userAgent)
  if (peerAddress) span.setTag(NETWORK_PEER_ADDRESS, peerAddress)
}

module.exports = addOtelRequestTags

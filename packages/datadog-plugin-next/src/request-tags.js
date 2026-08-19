'use strict'

const { NETWORK_PEER_ADDRESS } = require('../../dd-trace/src/plugins/util/http-otel-semantics')
const { extractURL, obfuscateQs } = require('../../dd-trace/src/plugins/util/url')

/**
 * Capture request data that Next.js does not publish through web.addRequestTags.
 *
 * @param {import('../../dd-trace/src/opentracing/span')} span
 * @param {Record<string, unknown>} config
 * @param {import('node:http').IncomingMessage} req
 * @returns {void}
 */
function addOtelRequestTags (span, config, req) {
  if (!config.DD_TRACE_OTEL_SEMANTICS_ENABLED || !req.headers) return

  span.setTag('http.url', obfuscateQs(config, extractURL(req)))
  // `web.addRequestTags` records this on the shared path; without it the conversion has no
  // `user_agent.original` to emit.
  const userAgent = req.headers['user-agent']
  if (userAgent !== undefined) span.setTag('http.useragent', userAgent)
  const peerAddress = req.socket?.remoteAddress
  if (peerAddress) span.setTag(NETWORK_PEER_ADDRESS, peerAddress)
}

module.exports = addOtelRequestTags

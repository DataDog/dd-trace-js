'use strict'

const { getActiveRequest } = require('../store')

// Per-request state shared by the request and response handlers.
const storedResponseHeaders = new WeakMap()
const adoptedRequests = new WeakMap()

/**
 * @param {{ req: object }} data
 */
function onHttp2ServerRequestAdopt ({ req }) {
  adoptedRequests.set(req, getActiveRequest())
}

/**
 * @param {object} req
 */
function getCanonicalRequest (req) {
  return adoptedRequests.get(req) ?? req
}

/**
 * @param {Record<string, unknown>} src
 * @param {string} omit
 * @returns {Record<string, unknown>}
 */
function copyHeadersOmitting (src, omit) {
  const filtered = {}
  for (const key of Object.keys(src)) {
    if (key !== omit) filtered[key] = src[key]
  }
  return filtered
}

module.exports = {
  storedResponseHeaders,
  copyHeadersOmitting,
  onHttp2ServerRequestAdopt,
  getCanonicalRequest,
}

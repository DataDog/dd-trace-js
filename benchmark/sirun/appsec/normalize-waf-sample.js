'use strict'

/**
 * Remove request values that vary between benchmark processes.
 *
 * @param {object} payload
 * @returns {object}
 */
module.exports = function normalizePayload (payload) {
  const normalized = JSON.parse(JSON.stringify(payload))
  const persistent = normalized.persistent
  const headers = persistent?.['server.request.headers.no_cookies']
  if (headers?.host) {
    headers.host = '127.0.0.1:<port>'
  }
  if (persistent?.['http.client_ip']) {
    persistent['http.client_ip'] = '<loopback>'
  }
  return normalized
}

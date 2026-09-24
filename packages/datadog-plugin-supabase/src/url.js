'use strict'

const { URL } = require('node:url')

/**
 * Extracts a hostname without allowing malformed SDK input to break instrumentation.
 *
 * @param {string|URL} url Request URL.
 * @returns {string|undefined} Parsed hostname.
 */
function getHostname (url) {
  try {
    return new URL(url).hostname
  } catch {}
}

module.exports = getHostname

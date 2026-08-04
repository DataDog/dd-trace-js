'use strict'

const url = require('url')

// This fixture deliberately exercises the legacy `url.parse()`, whose one-time
// DEP0169 deprecation warning is just noise in the benchmark output. Suppress
// that single code; forward every other warning untouched.
const originalEmitWarning = process.emitWarning
/**
 * @param {string | Error} warning
 * @param {...unknown} args
 */
process.emitWarning = function patchedEmitWarning (warning, ...args) {
  const code = typeof args[0] === 'object' && args[0] !== null
    ? /** @type {{ code?: string }} */ (args[0]).code
    : args[1]
  if (code === 'DEP0169') return
  return originalEmitWarning.call(this, warning, ...args)
}

/**
 * @returns {import('http').RequestListener}
 */
function loadInsecureBank () {
  // eslint-disable-next-line n/no-deprecated-api
  const parse = url.parse
  /**
   * @param {string} value
   * @param {boolean} [parseQueryString]
   * @param {boolean} [slashesDenoteHost]
   */
  // eslint-disable-next-line n/no-deprecated-api
  url.parse = function parseSqliteMemory (value, parseQueryString, slashesDenoteHost) {
    if (value === 'sqlite::memory:') {
      return {
        protocol: 'sqlite:',
        hostname: '',
        pathname: '/:memory:',
        query: {},
      }
    }

    return parse(value, parseQueryString, slashesDenoteHost)
  }

  try {
    return require('/opt/insecure-bank-js/app') // eslint-disable-line import/no-absolute-path
  } finally {
    // eslint-disable-next-line n/no-deprecated-api
    url.parse = parse
  }
}

module.exports = loadInsecureBank

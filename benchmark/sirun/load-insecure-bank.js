'use strict'

const url = require('url')

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

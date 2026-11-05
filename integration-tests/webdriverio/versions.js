'use strict'

const oldest = '9.0.0'

/**
 * @param {string} [selector]
 */
function getWebdriverioVersions (selector) {
  return selector ? [selector === 'oldest' ? oldest : selector] : [oldest, 'latest']
}

module.exports = { getWebdriverioVersions, oldest }

'use strict'

const { VERSION } = require('../../../../../version')

const LANGUAGE = 'nodejs'

/**
 * Returns the canonical client-library identification headers.
 *
 * @param {string} [language] - Client library language name.
 * @param {string} [version] - Client library version.
 * @returns {Record<string, string>} Client library identification headers.
 */
function getClientLibraryHeaders (language = LANGUAGE, version = VERSION) {
  return {
    'DD-Client-Library-Language': language,
    'DD-Client-Library-Version': version,
  }
}

module.exports = { getClientLibraryHeaders }

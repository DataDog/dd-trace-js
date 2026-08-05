'use strict'

const BABEL_7_PRESET_TYPESCRIPT_VERSION = '7.28.5'
const TYPESCRIPT_6_VERSION = '6.0.3'

/**
 * @param {string} cypressVersion
 * @returns {string[]}
 */
function getCypressDependencies (cypressVersion) {
  const dependencies = [
    `cypress@${cypressVersion}`,
    'cypress-fail-fast@7.1.0',
    `typescript@${TYPESCRIPT_6_VERSION}`,
  ]

  if (cypressVersion === 'latest') {
    dependencies.push(`@babel/preset-typescript@${BABEL_7_PRESET_TYPESCRIPT_VERSION}`)
  }

  return dependencies
}

module.exports = { getCypressDependencies }

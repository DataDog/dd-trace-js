'use strict'

const { satisfies } = require('semver')

const { NODE_VERSION } = require('../../version')

const BABEL_7_CORE_VERSION = '7.29.0'
const BABEL_7_PRESET_TYPESCRIPT_VERSION = '7.28.5'
const BABEL_8_NODE_RANGE = '^22.18.0 || >=24.11.0'

/**
 * @param {string} jestVersion
 * @param {string} [nodeVersion]
 * @returns {string[]}
 */
function getBabelDependencies (jestVersion, nodeVersion = NODE_VERSION) {
  if (jestVersion === 'latest' && satisfies(nodeVersion, BABEL_8_NODE_RANGE)) {
    return [
      '@babel/core',
      '@babel/preset-typescript',
    ]
  }

  return [
    `@babel/core@${BABEL_7_CORE_VERSION}`,
    `@babel/preset-typescript@${BABEL_7_PRESET_TYPESCRIPT_VERSION}`,
  ]
}

module.exports = { getBabelDependencies }

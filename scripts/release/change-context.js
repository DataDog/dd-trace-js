'use strict'

const INTERNAL_PATH_PATTERNS = [
  /^\.agents\//,
  /^\.github\//,
  /^\.gitlab(?:-ci\.yml|\/)/,
  /^benchmark\//,
  /^integration-tests\//,
  /^scripts\//,
  /(^|\/)(?:test|tests|benchmark)(?:\/|$)/,
  /\.(?:spec|test)\.[cm]?[jt]sx?$/,
  /(^|\/)(?:package-lock\.json|yarn\.lock)$/,
  /^(?:AGENTS\.md|CONTRIBUTING\.md|eslint\.config\.mjs|tsconfig(?:\.[^.]+)?\.json)$/,
]

/**
 * @param {string[]} files
 * @returns {boolean}
 */
function isInternalOnly (files) {
  if (files.length === 0) return false

  for (const file of files) {
    if (!isInternalPath(file)) return false
  }
  return true
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isInternalPath (file) {
  for (const pattern of INTERNAL_PATH_PATTERNS) {
    if (pattern.test(file)) return true
  }
  return false
}

module.exports = {
  isInternalOnly,
}

'use strict'

const PUBLIC_RELEASE_TYPES = new Set(['feat', 'fix', 'perf', 'docs'])

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

/**
 * @param {string|undefined} type
 * @param {string[]} files
 * @returns {string|undefined}
 */
function getReleaseNoteContextError (type, files) {
  if (type && PUBLIC_RELEASE_TYPES.has(type) && isInternalOnly(files)) {
    return `PR title type "${type}" is public, but every changed file is internal. ` +
      'Use test, bench, ci, or chore.'
  }
}

module.exports = {
  getReleaseNoteContextError,
  isInternalOnly,
}

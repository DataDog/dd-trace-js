'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ddTracePackage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))

const NODE_MATRIX_KEYS = new Set(['node', 'node-version', 'node_version', 'nodeversion'])

/**
 * Compares explicitly recorded CI Node matrix entries with the installed dd-trace runtime range.
 *
 * @param {object} framework manifest framework entry
 * @returns {object|undefined} compatibility evidence when concrete Node versions were recorded
 */
function getCiRuntimeCompatibility (framework) {
  const configuredNodeVersions = getConfiguredNodeVersions(framework.ciWiring?.matrix)
  if (configuredNodeVersions.length === 0) return

  const supportedRange = getSupportedNodeRange()
  const supportedNodeVersions = []
  const unsupportedNodeVersions = []

  for (const version of configuredNodeVersions) {
    const target = isSupportedNodeVersion(version, supportedRange)
      ? supportedNodeVersions
      : unsupportedNodeVersions
    target.push(version)
  }

  return {
    status: supportedNodeVersions.length === 0
      ? 'incompatible'
      : unsupportedNodeVersions.length === 0 ? 'compatible' : 'mixed',
    configuredNodeVersions,
    supportedNodeVersions,
    unsupportedNodeVersions,
    ddTraceSupportedRange: formatSupportedNodeRange(supportedRange),
  }
}

/**
 * Extracts concrete Node versions from CI matrix metadata without interpreting expressions.
 *
 * @param {unknown} matrix CI matrix metadata
 * @returns {string[]} unique concrete Node versions
 */
function getConfiguredNodeVersions (matrix) {
  const versions = []
  collectNodeVersions(matrix, false, versions)
  return [...new Set(versions)]
}

/**
 * Traverses bounded manifest metadata and records values under recognized Node matrix keys.
 *
 * @param {unknown} value current matrix value
 * @param {boolean} nodeVersionValue whether the current value belongs to a Node version key
 * @param {string[]} versions collected versions
 * @param {number} [depth] current traversal depth
 * @returns {void}
 */
function collectNodeVersions (value, nodeVersionValue, versions, depth = 0) {
  if (depth > 4 || versions.length >= 32) return

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 32)) {
      collectNodeVersions(entry, nodeVersionValue, versions, depth + 1)
    }
    return
  }

  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value).slice(0, 32)) {
      collectNodeVersions(entry, NODE_MATRIX_KEYS.has(key.toLowerCase()), versions, depth + 1)
    }
    return
  }

  if (!nodeVersionValue) return
  const version = normalizeNodeVersion(value)
  if (version) versions.push(version)
}

/**
 * Normalizes a concrete Node matrix value while rejecting expressions and broad aliases.
 *
 * @param {unknown} value matrix value
 * @returns {string|undefined} normalized version
 */
function normalizeNodeVersion (value) {
  if (typeof value !== 'string' && typeof value !== 'number') return
  const normalized = String(value).trim().replace(/^v/, '')
  if (!/^\d+(?:\.\d+){0,2}(?:\.x)?$/.test(normalized)) return
  return normalized
}

/**
 * Reads the installed package's bounded Node major range.
 *
 * @returns {{minimum: number|undefined, maximum: number|undefined}} supported range
 */
function getSupportedNodeRange () {
  const minimum = Number(ddTracePackage.engines?.node?.match(/^>=(\d+)/)?.[1])
  const maximum = Number(ddTracePackage.nodeMaxMajor)
  return {
    minimum: Number.isInteger(minimum) ? minimum : undefined,
    maximum: Number.isInteger(maximum) ? maximum : undefined,
  }
}

/**
 * Checks a concrete Node version against the installed package's major range.
 *
 * @param {string} version concrete Node version
 * @param {{minimum: number|undefined, maximum: number|undefined}} range supported range
 * @returns {boolean} whether the version is supported
 */
function isSupportedNodeVersion (version, range) {
  const major = Number(version.match(/^\d+/)?.[0])
  if (!Number.isInteger(major)) return false
  if (range.minimum !== undefined && major < range.minimum) return false
  if (range.maximum !== undefined && major >= range.maximum) return false
  return true
}

/**
 * Formats the installed package's supported Node range for customer-facing evidence.
 *
 * @param {{minimum: number|undefined, maximum: number|undefined}} range supported range
 * @returns {string} formatted range
 */
function formatSupportedNodeRange (range) {
  const parts = []
  if (range.minimum !== undefined) parts.push(`>=${range.minimum}`)
  if (range.maximum !== undefined) parts.push(`<${range.maximum}`)
  return parts.join(' ') || 'the runtime range declared by the installed dd-trace package'
}

module.exports = {
  getCiRuntimeCompatibility,
}

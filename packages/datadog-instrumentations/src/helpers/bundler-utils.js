'use strict'

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * @typedef {{ debug: (...args: unknown[]) => void, warn: (...args: unknown[]) => void }} BundlerLog
 */

/**
 * Determines if a file is a ESM module or CommonJS
 *
 * @param {string} fullPathToModule File to analyze
 * @param {string} [modulePackageJsonPath] Path of the package.json
 * @param {object} [packageJson] The content of the module package.json
 */
function isESMFile (fullPathToModule, modulePackageJsonPath, packageJson = {}) {
  if (fullPathToModule.endsWith('.mjs') || fullPathToModule.endsWith('.mts')) return true
  if (fullPathToModule.endsWith('.cjs') || fullPathToModule.endsWith('.cts')) return false

  const pathParts = fullPathToModule.split(path.sep)
  do {
    pathParts.pop()

    const packageJsonPath = [...pathParts, 'package.json'].join(path.sep)
    if (packageJsonPath === modulePackageJsonPath) {
      return packageJson.type === 'module'
    }

    try {
      const packageJsonContent = fs.readFileSync(packageJsonPath).toString()
      const packageJson = JSON.parse(packageJsonContent)
      return packageJson.type === 'module'
    } catch {
      // file does not exit, continue
    }
  } while (pathParts.length > 0)

  return packageJson.type === 'module'
}

/**
 * Reads the repository URL and commit SHA of the current working directory.
 *
 * @param {BundlerLog} log
 * @returns {{ repositoryURL: string | null, commitSHA: string | null }}
 */
function getGitMetadata (log) {
  /** @type {{ repositoryURL: string | null, commitSHA: string | null }} */
  const gitMetadata = {
    repositoryURL: null,
    commitSHA: null,
  }

  try {
    gitMetadata.repositoryURL = execSync('git config --get remote.origin.url', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: process.cwd(),
    }).trim()
  } catch (e) {
    log.warn('failed to get git repository URL:', e.message)
  }

  try {
    gitMetadata.commitSHA = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: process.cwd(),
    }).trim()
  } catch (e) {
    log.warn('failed to get git commit SHA:', e.message)
  }

  return gitMetadata
}

/**
 * Returns a script setting `DD_GIT_REPOSITORY_URL` and `DD_GIT_COMMIT_SHA` from the git metadata of the current working
 * directory, to prepend to the entry chunks of a bundle. Returns an empty string when no metadata is available.
 *
 * @param {BundlerLog} log
 */
function getGitMetadataBanner (log) {
  const { repositoryURL, commitSHA } = getGitMetadata(log)
  if (!repositoryURL && !commitSHA) {
    log.warn('No git metadata available - skipping injection')
    return ''
  }

  log.debug(
    'Automatically injected git metadata (DD_GIT_REPOSITORY_URL: %s, DD_GIT_COMMIT_SHA: %s)',
    repositoryURL || 'not available',
    commitSHA || 'not available'
  )
  return 'if (typeof process === \'object\' && process !== null &&\n' +
    '    process.env !== null && typeof process.env === \'object\') {\n' +
    (repositoryURL ? `  process.env.DD_GIT_REPOSITORY_URL = ${JSON.stringify(repositoryURL)};\n` : '') +
    (commitSHA ? `  process.env.DD_GIT_COMMIT_SHA = ${JSON.stringify(commitSHA)};\n` : '') +
    '}\n'
}

module.exports = { getGitMetadataBanner, isESMFile }

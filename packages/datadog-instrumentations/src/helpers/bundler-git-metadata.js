'use strict'

const { execSync } = require('node:child_process')

/**
 * Reads the repository URL and commit SHA of the current working directory.
 *
 * @param {{ warn: (...args: unknown[]) => void }} log
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

module.exports = { getGitMetadata }

'use strict'

const BUILD_DIRECTORY_PATTERN = /(?:^|\/)(?:build|dist|generated)(?:\/|$)/
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//

/**
 * Returns whether a path names a project-owned conventional build output.
 *
 * Bare package subpaths and paths below node_modules belong to dependencies, not to the customer project.
 *
 * @param {string} filename referenced path
 * @returns {boolean} whether the path is project-owned build output
 */
function isProjectBuildArtifactPath (filename) {
  const normalized = String(filename).replaceAll('\\', '/')
  if (!BUILD_DIRECTORY_PATTERN.test(normalized) ||
    /(?:^|\/)node_modules(?:\/|$)/.test(normalized)) return false

  return normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized)
}

module.exports = { isProjectBuildArtifactPath }

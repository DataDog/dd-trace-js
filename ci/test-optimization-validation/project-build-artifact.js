'use strict'

const path = require('node:path')

const BUILD_DIRECTORY_PATTERN = /(?:^|\/)(?:build|dist|generated)(?:\/|$)/
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//

/**
 * Returns whether a path names a project-owned conventional build output.
 *
 * Bare package subpaths and paths below node_modules belong to dependencies, not to the customer project.
 *
 * @param {string} filename referenced path
 * @param {string} projectRoot owning project root
 * @returns {boolean} whether the path is project-owned build output
 */
function isProjectBuildArtifactPath (filename, projectRoot) {
  const normalized = String(filename).replaceAll('\\', '/')
  if (!BUILD_DIRECTORY_PATTERN.test(normalized) ||
    /(?:^|\/)node_modules(?:\/|$)/.test(normalized)) return false

  if (normalized.startsWith('./') || normalized.startsWith('../')) return true
  if ((!normalized.startsWith('/') && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized)) ||
    typeof projectRoot !== 'string') return false

  const normalizedRoot = projectRoot.replaceAll('\\', '/')
  const windowsPath = WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized)
  const windowsRoot = WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedRoot)
  if (windowsPath !== windowsRoot && windowsPath) return false
  const pathApi = windowsRoot ? path.win32 : path.posix
  const root = pathApi.resolve(normalizedRoot)
  const candidate = /^\/(?:build|dist|generated)(?:\/|$)/.test(normalized)
    ? pathApi.resolve(root, normalized.slice(1))
    : pathApi.resolve(normalized)
  const relative = pathApi.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
}

module.exports = { isProjectBuildArtifactPath }

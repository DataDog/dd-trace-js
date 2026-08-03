'use strict'

const path = require('node:path')

const BUILD_DIRECTORY_PATTERN = /(?:^|\/)(?:build|dist|generated)(?:\/|$)/
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//

// Bare package subpaths and node_modules paths belong to dependencies, not to the customer project.
function isProjectBuildArtifactPath (filename, projectRoot, baseDirectory = projectRoot) {
  const normalized = String(filename).replaceAll('\\', '/')
  if (!BUILD_DIRECTORY_PATTERN.test(normalized) ||
    /(?:^|\/)node_modules(?:\/|$)/.test(normalized)) return false

  const relativePath = normalized.startsWith('./') || normalized.startsWith('../')
  if ((!relativePath && !normalized.startsWith('/') && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized)) ||
    typeof projectRoot !== 'string') return false

  const normalizedRoot = projectRoot.replaceAll('\\', '/')
  const windowsPath = WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized)
  const windowsRoot = WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedRoot)
  if (windowsPath !== windowsRoot && windowsPath) return false
  const pathApi = windowsRoot ? path.win32 : path.posix
  const root = pathApi.resolve(normalizedRoot)
  const candidate = relativePath
    ? pathApi.resolve(String(baseDirectory).replaceAll('\\', '/'), normalized)
    : pathApi.resolve(normalized)
  const relative = pathApi.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
}

module.exports = { isProjectBuildArtifactPath }

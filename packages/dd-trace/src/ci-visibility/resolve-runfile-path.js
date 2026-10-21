'use strict'

const fs = require('node:fs')
const path = require('node:path')

const log = require('../log')

/**
 * @param {string} filePath
 * @param {Record<string, string | undefined>} env
 */
function resolveRunfilePath (filePath, env) {
  if (fs.existsSync(filePath)) return filePath

  const runfilesDir = env.RUNFILES_DIR
  if (runfilesDir) {
    const candidate = path.join(runfilesDir, filePath)
    if (fs.existsSync(candidate)) return candidate
  }

  const manifestCandidate = resolveFromManifest(filePath, env.RUNFILES_MANIFEST_FILE)
  if (manifestCandidate) return manifestCandidate

  const testSrcdir = env.TEST_SRCDIR
  if (testSrcdir) {
    const candidate = path.join(testSrcdir, filePath)
    if (fs.existsSync(candidate)) return candidate
  }

  return filePath
}

/**
 * @param {string} filePath
 * @param {string | undefined} runfilesManifest
 */
function resolveFromManifest (filePath, runfilesManifest) {
  if (!runfilesManifest || !fs.existsSync(runfilesManifest)) return

  try {
    const lines = fs.readFileSync(runfilesManifest, 'utf8').split('\n')
    for (const line of lines) {
      const separatorIndex = line.indexOf(' ')
      if (separatorIndex <= 0 || line.slice(0, separatorIndex) !== filePath) continue

      const resolvedPath = line.slice(separatorIndex + 1).trim()
      if (resolvedPath) return resolvedPath
    }
  } catch (err) {
    log.debug('Failed to resolve Test Optimization runfile from %s: %s', runfilesManifest, err.message)
  }
}

module.exports = resolveRunfilePath

'use strict'

const fs = require('fs')
const path = require('path')

const RUNTIME_FILE_NAMESPACE = 'dd-test-optimization-validation'
const writtenGeneratedFiles = new Set()

function writeGeneratedFiles (framework) {
  const strategy = framework.generatedTestStrategy
  if (!strategy || strategy.status !== 'verified') {
    return []
  }

  const written = []
  try {
    for (const file of strategy.files || []) {
      const filename = validateGeneratedFilePath(framework, file.path)
      validateContentLines(file.contentLines, filename)
      const content = `${file.contentLines.join('\n')}\n`
      if (fs.existsSync(filename)) {
        if (fs.readFileSync(filename, 'utf8') === content) continue
        throw new Error(`Refusing to overwrite existing generated validation file with different content: ${filename}`)
      }

      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, content)
      writtenGeneratedFiles.add(filename)
      written.push(filename)
    }
  } catch (err) {
    cleanupPaths(written)
    forgetWrittenGeneratedFiles(written)
    throw err
  }
  return written
}

function cleanupGeneratedFiles (manifest, { keep = false } = {}) {
  if (keep) return

  for (const framework of manifest.frameworks || []) {
    const strategy = framework.generatedTestStrategy
    cleanupPaths(getSafeCleanupPaths(framework, strategy, { includeGeneratedFiles: true }))
  }
}

function cleanupGeneratedRuntimeFiles (framework) {
  const strategy = framework.generatedTestStrategy
  if (!strategy) return

  cleanupPaths(getSafeCleanupPaths(framework, strategy, { includeGeneratedFiles: false }))
}

function getSafeCleanupPaths (framework, strategy, { includeGeneratedFiles }) {
  if (!strategy) return []

  const generatedFiles = new Set()
  for (const file of strategy.files || []) {
    generatedFiles.add(validateGeneratedFilePath(framework, file.path))
  }

  const cleanupPaths = []
  for (const cleanupPath of strategy.cleanupPaths || []) {
    const filename = validateCleanupPath(framework, cleanupPath)
    if (generatedFiles.has(filename)) {
      if (includeGeneratedFiles && writtenGeneratedFiles.has(filename)) cleanupPaths.push(filename)
      continue
    }

    if (isNamespacedRuntimeFile(filename)) {
      cleanupPaths.push(filename)
    }
  }

  if (includeGeneratedFiles) {
    for (const filename of generatedFiles) {
      if (writtenGeneratedFiles.has(filename)) cleanupPaths.push(filename)
    }
  }
  return [...new Set(cleanupPaths)]
}

function cleanupPaths (cleanupPaths) {
  for (const cleanupPath of cleanupPaths) {
    try {
      if (isDirectory(cleanupPath)) continue
      fs.rmSync(cleanupPath, { force: true })
      writtenGeneratedFiles.delete(cleanupPath)
    } catch {
      // Cleanup should be best-effort. The report will contain the command artifacts.
    }
  }
}

function forgetWrittenGeneratedFiles (filenames) {
  for (const filename of filenames) {
    writtenGeneratedFiles.delete(filename)
  }
}

function validateGeneratedFilePath (framework, filename) {
  return validatePathUnderProjectRoot(framework, filename, 'generated validation file')
}

function validateCleanupPath (framework, filename) {
  return validatePathUnderProjectRoot(framework, filename, 'generated validation cleanup')
}

function validatePathUnderProjectRoot (framework, filename, label) {
  const root = getProjectRoot(framework)
  const resolved = path.resolve(filename || '')
  if (!root || !isPathInside(root, resolved)) {
    throw new Error(`Refusing ${label} path outside project root: ${filename}`)
  }
  return resolved
}

function getProjectRoot (framework) {
  const root = framework.project?.root
  return typeof root === 'string' && path.isAbsolute(root) ? path.resolve(root) : null
}

function isPathInside (root, filename) {
  const relative = path.relative(root, filename)
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateContentLines (contentLines, filename) {
  if (!Array.isArray(contentLines) || contentLines.some(line => typeof line !== 'string')) {
    throw new Error(`Generated validation file contentLines must be an array of strings: ${filename}`)
  }
}

function isNamespacedRuntimeFile (filename) {
  return path.basename(filename).includes(RUNTIME_FILE_NAMESPACE)
}

function isDirectory (filename) {
  try {
    return fs.statSync(filename).isDirectory()
  } catch {
    return false
  }
}

function findGeneratedScenario (framework, scenarioId) {
  return (framework.generatedTestStrategy?.scenarios || []).find(scenario => scenario.id === scenarioId)
}

module.exports = {
  cleanupGeneratedFiles,
  cleanupGeneratedRuntimeFiles,
  findGeneratedScenario,
  writeGeneratedFiles,
}

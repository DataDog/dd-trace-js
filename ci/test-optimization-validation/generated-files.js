'use strict'

const fs = require('fs')
const path = require('path')

const { createFileSafely, ensureSafeDirectory } = require('./safe-files')

const RUNTIME_FILE_NAMESPACE = 'dd-test-optimization-validation'
const createdGeneratedDirectories = new Set()
const writtenGeneratedFiles = new Set()

function writeGeneratedFiles (framework) {
  const strategy = framework.generatedTestStrategy
  if (!strategy || !['planned', 'verified'].includes(strategy.status)) {
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

      const directory = path.dirname(filename)
      const missingDirectories = getMissingDirectories(framework.project.root, directory)
      ensureSafeDirectory(framework.project.root, directory, 'generated validation file directory', {
        allowRootSymlink: true,
      })
      for (const createdDirectory of missingDirectories) createdGeneratedDirectories.add(createdDirectory)
      validateGeneratedFilePath(framework, filename)
      createFileSafely(framework.project.root, filename, content, 'generated validation file')
      writtenGeneratedFiles.add(filename)
      written.push(filename)
    }
  } catch (err) {
    cleanupPaths(written)
    cleanupCreatedDirectories(framework.project.root)
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
    cleanupCreatedDirectories(framework.project.root)
  }
}

/**
 * Finds missing directories that the validator will create for one generated file.
 *
 * @param {string} root project root
 * @param {string} directory generated file directory
 * @returns {string[]} missing directories, from deepest to shallowest
 */
function getMissingDirectories (root, directory) {
  const missing = []
  let current = path.resolve(directory)
  const resolvedRoot = path.resolve(root)
  while (current !== resolvedRoot && isPathInside(resolvedRoot, current) && !fs.existsSync(current)) {
    missing.push(current)
    current = path.dirname(current)
  }
  return missing
}

/**
 * Removes empty generated directories created by this validator process.
 *
 * @param {string} root project root
 */
function cleanupCreatedDirectories (root) {
  const resolvedRoot = path.resolve(root)
  const directories = [...createdGeneratedDirectories]
    .filter(directory => isPathInside(resolvedRoot, directory))
    .sort((left, right) => right.length - left.length)

  for (const directory of directories) {
    try {
      fs.rmdirSync(directory)
      createdGeneratedDirectories.delete(directory)
    } catch (error) {
      if (error.code === 'ENOENT') createdGeneratedDirectories.delete(directory)
    }
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
  const runtimeDirectories = new Set()
  for (const filename of generatedFiles) {
    runtimeDirectories.add(path.dirname(filename))
  }
  for (const cleanupPath of strategy.cleanupPaths || []) {
    const filename = validateCleanupPath(framework, cleanupPath)
    if (generatedFiles.has(filename)) {
      if (includeGeneratedFiles && writtenGeneratedFiles.has(filename)) cleanupPaths.push(filename)
      continue
    }

    if (isDirectory(filename)) {
      runtimeDirectories.add(filename)
    } else if (isNamespacedRuntimeFile(filename)) {
      cleanupPaths.push(filename)
    }
  }

  for (const directory of runtimeDirectories) {
    cleanupPaths.push(...findNamespacedRuntimeFiles(framework, directory, generatedFiles))
  }

  if (includeGeneratedFiles) {
    for (const filename of generatedFiles) {
      if (writtenGeneratedFiles.has(filename)) cleanupPaths.push(filename)
    }
  }
  return [...new Set(cleanupPaths)]
}

function findNamespacedRuntimeFiles (framework, directory, generatedFiles) {
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }

  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !isNamespacedRuntimeFile(entry.name)) continue
    const filename = validateCleanupPath(framework, path.join(directory, entry.name))
    if (!generatedFiles.has(filename)) files.push(filename)
  }
  return files
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
  validatePhysicalPath(root, resolved, label)
  return resolved
}

/**
 * Verifies that an existing parent resolves inside the physical project root.
 *
 * @param {string} root project root
 * @param {string} filename candidate filename
 * @param {string} label customer-facing path label
 */
function validatePhysicalPath (root, filename, label) {
  const parent = path.dirname(filename)
  let physicalRoot
  let physicalParent
  try {
    physicalRoot = fs.realpathSync(root)
    physicalParent = fs.realpathSync(parent)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }

  if (!isPathInside(physicalRoot, physicalParent)) {
    throw new Error(`Refusing ${label} path outside physical project root: ${filename}`)
  }
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) {
      throw new Error(`Refusing ${label} symbolic-link target: ${filename}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
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

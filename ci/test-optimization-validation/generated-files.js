'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  MAX_GENERATED_FILES,
  getGeneratedFileContentError,
} = require('./generated-file-policy')
const { createFileSafely, ensureSafeDirectory } = require('./safe-files')

const RUNTIME_FILE_NAMESPACE = 'dd-test-optimization-validation'
const createdGeneratedDirectories = new Map()
const initializedCleanupStrategies = new WeakSet()
const authorizedRuntimeCleanupFiles = new Map()
const writtenGeneratedFiles = new Map()

function writeGeneratedFiles (framework, scenario) {
  const strategy = framework.generatedTestStrategy
  if (!strategy || !['planned', 'verified'].includes(strategy.status)) {
    return []
  }
  if ((strategy.files || []).length > MAX_GENERATED_FILES) {
    throw new Error(`Generated validation strategy must contain at most ${MAX_GENERATED_FILES} files.`)
  }
  initializeRuntimeCleanupFiles(framework, strategy)

  const written = []
  const files = getScenarioFiles(strategy, scenario)
  try {
    for (const file of files) {
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
      for (const createdDirectory of missingDirectories) {
        createdGeneratedDirectories.set(
          createdDirectory,
          authorizePathForCleanup(framework.project.root, createdDirectory)
        )
      }
      validateGeneratedFilePath(framework, filename)
      createFileSafely(framework.project.root, filename, content, 'generated validation file')
      writtenGeneratedFiles.set(filename, authorizePathForCleanup(framework.project.root, filename))
      written.push(filename)
    }
    pinRuntimeCleanupParents(strategy)
  } catch (err) {
    cleanupPaths(written)
    cleanupCreatedDirectories(framework.project.root)
    forgetWrittenGeneratedFiles(written)
    throw err
  }
  return written
}

/**
 * Returns one scenario file plus adapter support files, or every file when no scenario is selected.
 *
 * @param {object} strategy generated strategy
 * @param {object|undefined} scenario selected generated scenario
 * @returns {object[]} generated files to write
 */
function getScenarioFiles (strategy, scenario) {
  if (!scenario) return strategy.files || []
  const scenarioPaths = new Set((strategy.scenarios || []).map(candidate => {
    return path.resolve(candidate.testIdentities[0].file)
  }))
  const selectedPath = path.resolve(scenario.testIdentities[0].file)
  return (strategy.files || []).filter(file => {
    const filename = path.resolve(file.path)
    return filename === selectedPath || !scenarioPaths.has(filename)
  })
}

function cleanupGeneratedFiles (manifest, { keep = false } = {}) {
  if (keep) return { status: 'retained_by_request' }

  const outcome = {
    directoriesRemoved: 0,
    directoriesRetained: 0,
    filesRemoved: 0,
    filesRetained: 0,
  }
  if (manifest.frameworks) {
    for (const framework of manifest.frameworks) {
      const strategy = framework.generatedTestStrategy
      addCleanupOutcome(
        outcome,
        cleanupPaths(getSafeCleanupPaths(framework, strategy, { includeGeneratedFiles: true })),
        'files'
      )
      addCleanupOutcome(outcome, cleanupCreatedDirectories(framework.project.root), 'directories')
    }
  }
  outcome.status = outcome.filesRetained > 0 || outcome.directoriesRetained > 0
    ? 'incomplete'
    : 'completed'
  return outcome
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
  const outcome = { removed: 0, retained: 0 }
  const resolvedRoot = path.resolve(root)
  const directories = [...createdGeneratedDirectories]
    .filter(([directory]) => isPathInside(resolvedRoot, directory))
    .sort(([left], [right]) => right.length - left.length)

  for (const [directory, authorization] of directories) {
    if (!isCleanupAuthorizationValid(directory, authorization)) {
      if (pathExists(directory)) outcome.retained++
      continue
    }
    try {
      fs.rmdirSync(directory)
      createdGeneratedDirectories.delete(directory)
      outcome.removed++
    } catch (error) {
      if (error.code === 'ENOENT') {
        createdGeneratedDirectories.delete(directory)
      } else {
        outcome.retained++
      }
    }
  }
  return outcome
}

function cleanupGeneratedRuntimeFiles (framework) {
  const strategy = framework.generatedTestStrategy
  if (!strategy) return

  initializeRuntimeCleanupFiles(framework, strategy)
  cleanupPaths(getSafeCleanupPaths(framework, strategy, { includeGeneratedFiles: false }))
}

function initializeRuntimeCleanupFiles (framework, strategy) {
  if (initializedCleanupStrategies.has(strategy)) return

  const generatedFiles = new Set((strategy.files || []).map(file => validateGeneratedFilePath(framework, file.path)))
  if (strategy.cleanupPaths) {
    for (const cleanupPath of strategy.cleanupPaths) {
      const filename = validateCleanupPath(framework, cleanupPath)
      if (generatedFiles.has(filename) || isDirectory(filename) || !isNamespacedRuntimeFile(filename)) continue
      if (fs.existsSync(filename)) {
        throw new Error(`Refusing to delete pre-existing generated validation runtime file: ${filename}`)
      }
      authorizedRuntimeCleanupFiles.set(filename, authorizePathForCleanup(framework.project.root, filename))
    }
  }
  initializedCleanupStrategies.add(strategy)
}

function getSafeCleanupPaths (framework, strategy, { includeGeneratedFiles }) {
  if (!strategy) return []

  const generatedFiles = new Set()
  if (strategy.files) {
    for (const file of strategy.files) {
      generatedFiles.add(validateGeneratedFilePath(framework, file.path))
    }
  }

  const cleanupPaths = []
  if (strategy.cleanupPaths) {
    for (const cleanupPath of strategy.cleanupPaths) {
      const filename = validateCleanupPath(framework, cleanupPath)
      if (generatedFiles.has(filename)) {
        if (includeGeneratedFiles && writtenGeneratedFiles.has(filename)) cleanupPaths.push(filename)
        continue
      }

      if (authorizedRuntimeCleanupFiles.has(filename)) {
        cleanupPaths.push(filename)
      }
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
  const outcome = { removed: 0, retained: 0 }
  for (const cleanupPath of cleanupPaths) {
    try {
      const authorization = writtenGeneratedFiles.get(cleanupPath) ||
        authorizedRuntimeCleanupFiles.get(cleanupPath)
      if (!authorization || !isCleanupAuthorizationValid(cleanupPath, authorization) || isDirectory(cleanupPath)) {
        if (pathExists(cleanupPath)) outcome.retained++
        continue
      }
      fs.rmSync(cleanupPath, { force: true })
      writtenGeneratedFiles.delete(cleanupPath)
      outcome.removed++
    } catch {
      if (pathExists(cleanupPath)) outcome.retained++
    }
  }
  return outcome
}

function addCleanupOutcome (target, outcome, kind) {
  target[`${kind}Removed`] += outcome.removed
  target[`${kind}Retained`] += outcome.retained
}

function pathExists (filename) {
  try {
    fs.lstatSync(filename)
    return true
  } catch {
    return false
  }
}

function forgetWrittenGeneratedFiles (filenames) {
  for (const filename of filenames) {
    writtenGeneratedFiles.delete(filename)
  }
}

function authorizePathForCleanup (root, filename) {
  const lexicalRoot = path.resolve(root)
  const physicalRoot = fs.realpathSync(lexicalRoot)
  const rootStat = fs.statSync(physicalRoot, { bigint: true })
  const authorization = {
    lexicalRoot,
    physicalRoot,
    rootDevice: rootStat.dev,
    rootInode: rootStat.ino,
  }
  pinCleanupParent(authorization, filename)
  pinCleanupTarget(authorization, filename)
  return authorization
}

function pinRuntimeCleanupParents (strategy) {
  if (strategy.cleanupPaths) {
    for (const cleanupPath of strategy.cleanupPaths) {
      const authorization = authorizedRuntimeCleanupFiles.get(path.resolve(cleanupPath))
      if (authorization && authorization.physicalParent === undefined) {
        pinCleanupParent(authorization, cleanupPath)
      }
    }
  }
}

function pinCleanupParent (authorization, filename) {
  try {
    const physicalParent = fs.realpathSync(path.dirname(filename))
    if (!isPathInside(authorization.physicalRoot, physicalParent)) return
    const parentStat = fs.statSync(physicalParent, { bigint: true })
    authorization.physicalParent = physicalParent
    authorization.parentDevice = parentStat.dev
    authorization.parentInode = parentStat.ino
  } catch {}
}

function pinCleanupTarget (authorization, filename) {
  try {
    const targetStat = fs.lstatSync(filename, { bigint: true })
    authorization.targetDevice = targetStat.dev
    authorization.targetInode = targetStat.ino
  } catch {}
}

function isCleanupAuthorizationValid (filename, authorization) {
  try {
    const currentPhysicalRoot = fs.realpathSync(authorization.lexicalRoot)
    const rootStat = fs.statSync(currentPhysicalRoot, { bigint: true })
    if (currentPhysicalRoot !== authorization.physicalRoot ||
      rootStat.dev !== authorization.rootDevice || rootStat.ino !== authorization.rootInode) {
      return false
    }

    if (authorization.physicalParent === undefined) return false
    const physicalParent = fs.realpathSync(path.dirname(filename))
    const parentStat = fs.statSync(physicalParent, { bigint: true })
    if (physicalParent !== authorization.physicalParent ||
      parentStat.dev !== authorization.parentDevice || parentStat.ino !== authorization.parentInode) {
      return false
    }

    if (authorization.targetDevice !== undefined) {
      const targetStat = fs.lstatSync(filename, { bigint: true })
      if (targetStat.dev !== authorization.targetDevice || targetStat.ino !== authorization.targetInode) {
        return false
      }
    }
    return true
  } catch {
    return false
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
  const policyError = getGeneratedFileContentError(contentLines)
  if (policyError) {
    throw new Error(`Generated validation file ${policyError}: ${filename}`)
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

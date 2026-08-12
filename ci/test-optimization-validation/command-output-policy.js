'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createValidationBlocker } = require('./validation-blocker')

/**
 * Returns command-created paths that must be declared and removed after validation.
 *
 * @param {object} command structured command
 * @returns {string[]} absolute output paths
 */
function getCommandOutputPaths (command) {
  return [...new Set((command.outputPaths || []).map(outputPath => path.resolve(command.cwd, outputPath)))]
}

/**
 * Refuses pre-existing outputs and records parent identities for fail-closed cleanup.
 *
 * @param {object} input isolation inputs
 * @param {object} input.command structured command
 * @param {string} input.artifactRoot validation results root
 * @param {string} [input.repositoryRoot] repository root
 * @returns {{outputPath: string, repositoryRoot: string, parentIdentities: object[]}[]} cleanup state
 */
function prepareCommandOutputs ({ command, artifactRoot, repositoryRoot }) {
  repositoryRoot = path.resolve(repositoryRoot || path.dirname(path.resolve(artifactRoot)))
  const states = []
  const outputPaths = getCommandOutputPaths(command)

  for (const outputPath of outputPaths) {
    assertSafeOutputPath({ outputPath, repositoryRoot, artifactRoot, command })
  }
  for (const outputPath of outputPaths) {
    if (pathExists(outputPath)) {
      throw createValidationBlocker(
        `Command output path already exists and will not be moved or overwritten: ${outputPath}. ` +
        'The validator will not delete pre-existing output.',
        {
          kind: 'command-output-exists',
          recommendation: `Inspect ${outputPath}. Remove it manually only if it is disposable validator or test ` +
            'output, or choose a fresh output path, then render and approve a fresh plan.',
        }
      )
    }
    states.push({
      outputPath,
      repositoryRoot,
      parentIdentities: captureExistingParentIdentities(outputPath, repositoryRoot),
    })
  }

  return states
}

/**
 * Removes outputs created by a command after revalidating every parent component.
 *
 * @param {{outputPath: string, repositoryRoot: string, parentIdentities: object[]}[]} states cleanup state
 * @returns {object[]} customer-safe cleanup summary
 */
function cleanupCommandOutputs (states) {
  const actions = []
  for (let index = states.length - 1; index >= 0; index--) {
    const state = states[index]
    assertOutputParentsUnchanged(state)
    const existed = fs.existsSync(state.outputPath)
    if (existed) fs.rmSync(state.outputPath, { force: true, recursive: true })
    actions.push({ outputPath: state.outputPath, action: existed ? 'removed' : 'absent' })
  }
  return actions.reverse()
}

/**
 * Records every existing directory from repository.root through an output parent.
 *
 * @param {string} outputPath output path
 * @param {string} repositoryRoot repository root
 * @returns {{path: string, dev: bigint, ino: bigint}[]} parent identities
 */
function captureExistingParentIdentities (outputPath, repositoryRoot) {
  const identities = []
  const relative = path.relative(repositoryRoot, path.dirname(outputPath))
  let current = repositoryRoot
  for (const segment of relative ? relative.split(path.sep) : []) {
    const stat = fs.lstatSync(current, { bigint: true })
    assertRegularDirectory(stat, current)
    identities.push({ path: current, dev: stat.dev, ino: stat.ino })
    current = path.join(current, segment)
    if (!pathExists(current)) return identities
  }

  const stat = fs.lstatSync(current, { bigint: true })
  assertRegularDirectory(stat, current)
  identities.push({ path: current, dev: stat.dev, ino: stat.ino })
  return identities
}

/**
 * Refuses cleanup if an existing parent changed or a new parent is a symbolic link.
 *
 * @param {object} state cleanup state
 */
function assertOutputParentsUnchanged (state) {
  for (const identity of state.parentIdentities) {
    const stat = fs.lstatSync(identity.path, { bigint: true })
    assertRegularDirectory(stat, identity.path)
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new Error(`Refusing command output cleanup because a parent directory changed: ${identity.path}`)
    }
  }

  const lastExisting = state.parentIdentities.at(-1).path
  const relative = path.relative(lastExisting, path.dirname(state.outputPath))
  let current = lastExisting
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment)
    if (!pathExists(current)) break
    assertRegularDirectory(fs.lstatSync(current), current)
  }
}

/**
 * Refuses symbolic links and non-directory parent components.
 *
 * @param {fs.Stats | fs.BigIntStats} stat path status
 * @param {string} directory directory path
 */
function assertRegularDirectory (stat, directory) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing command output cleanup through a non-regular directory: ${directory}`)
  }
}

function pathExists (filename) {
  try {
    fs.lstatSync(filename)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function assertSafeOutputPath ({ outputPath, repositoryRoot, artifactRoot, command }) {
  const relative = path.relative(repositoryRoot, outputPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Command output path must be a child of repository.root: ${outputPath}`)
  }
  assertPhysicalOutputPathInsideRepository(outputPath, repositoryRoot)
  if (isPathInside(artifactRoot, outputPath) || isPathInside(outputPath, artifactRoot)) {
    throw new Error(`Command output path must not contain or overlap validation artifacts: ${outputPath}`)
  }
  if (path.resolve(command.cwd) === outputPath) {
    throw new Error(`Command output path must not replace the command working directory: ${outputPath}`)
  }
}

/**
 * Rejects an output whose nearest existing ancestor resolves outside the repository.
 *
 * @param {string} outputPath absolute output path
 * @param {string} repositoryRoot absolute repository root
 * @returns {void}
 */
function assertPhysicalOutputPathInsideRepository (outputPath, repositoryRoot) {
  const physicalRoot = fs.realpathSync(repositoryRoot)
  let existingPath = outputPath
  while (!fs.existsSync(existingPath) && path.dirname(existingPath) !== existingPath) {
    existingPath = path.dirname(existingPath)
  }

  const physicalExistingPath = fs.realpathSync(existingPath)
  if (!isPathInside(physicalRoot, physicalExistingPath)) {
    throw new Error(`Command output path must not resolve outside physical repository.root: ${outputPath}`)
  }
}

function isPathInside (directory, filename) {
  const relative = path.relative(path.resolve(directory), path.resolve(filename))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

module.exports = {
  cleanupCommandOutputs,
  getCommandOutputPaths,
  prepareCommandOutputs,
}

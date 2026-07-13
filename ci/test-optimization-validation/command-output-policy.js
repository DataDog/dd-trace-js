'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Returns command-created paths that must be declared and restored after validation.
 *
 * @param {object} command structured command
 * @returns {string[]} absolute output paths
 */
function getCommandOutputPaths (command) {
  const paths = new Set((command.outputPaths || []).map(outputPath => path.resolve(command.cwd, outputPath)))
  const tokens = command.usesShell ? tokenizeShell(command.shellCommand) : command.argv || []
  const coverageDirectory = getCoverageDirectory(tokens)
  if (coverageDirectory) paths.add(path.resolve(command.cwd, coverageDirectory))
  return [...paths]
}

/**
 * Moves pre-existing command outputs aside so the validator can restore them exactly.
 *
 * @param {object} input isolation inputs
 * @param {object} input.command structured command
 * @param {string} input.artifactRoot validation results root
 * @param {string} input.outDir command artifact directory
 * @param {string} [input.repositoryRoot] repository root
 * @returns {{outputPath: string, backupPath?: string, existed: boolean}[]} restoration state
 */
function prepareCommandOutputs ({ command, artifactRoot, outDir, repositoryRoot }) {
  repositoryRoot = path.resolve(repositoryRoot || path.dirname(path.resolve(artifactRoot)))
  const backupRoot = path.join(outDir, '.command-output-backup')
  const states = []

  try {
    for (const [index, outputPath] of getCommandOutputPaths(command).entries()) {
      assertSafeOutputPath({ outputPath, repositoryRoot, artifactRoot, command })
      const existed = fs.existsSync(outputPath)
      const state = { outputPath, existed }
      if (existed) {
        const backupPath = path.join(backupRoot, String(index))
        fs.mkdirSync(path.dirname(backupPath), { recursive: true })
        fs.renameSync(outputPath, backupPath)
        state.backupPath = backupPath
      }
      states.push(state)
    }
  } catch (error) {
    restoreCommandOutputs(states)
    throw error
  }

  return states
}

/**
 * Removes outputs created by a command and restores any pre-existing path.
 *
 * @param {{outputPath: string, backupPath?: string, existed: boolean}[]} states restoration state
 * @returns {object[]} customer-safe cleanup summary
 */
function restoreCommandOutputs (states) {
  const actions = []
  for (let index = states.length - 1; index >= 0; index--) {
    const state = states[index]
    fs.rmSync(state.outputPath, { force: true, recursive: true })
    if (state.existed) {
      fs.mkdirSync(path.dirname(state.outputPath), { recursive: true })
      fs.renameSync(state.backupPath, state.outputPath)
      actions.push({ outputPath: state.outputPath, action: 'restored' })
    } else {
      actions.push({ outputPath: state.outputPath, action: 'removed' })
    }
  }
  return actions.reverse()
}

function getCoverageDirectory (tokens) {
  let coverageEnabled = false
  for (let index = 0; index < tokens.length; index++) {
    const token = String(tokens[index])
    if (token === '--coverage' || token === '--coverage=true') coverageEnabled = true
    const inline = /^(?:--coverageDirectory|--coverage-directory|--coverage\.reportsDirectory)=(.+)$/.exec(token)
    if (inline) return inline[1]
    if (['--coverageDirectory', '--coverage-directory', '--coverage.reportsDirectory'].includes(token)) {
      return tokens[index + 1]
    }
  }
  return coverageEnabled ? 'coverage' : undefined
}

function tokenizeShell (source) {
  return String(source || '').match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(token => {
    return token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
  }) || []
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
  getCommandOutputPaths,
  prepareCommandOutputs,
  restoreCommandOutputs,
}

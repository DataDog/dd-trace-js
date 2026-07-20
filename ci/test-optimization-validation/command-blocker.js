'use strict'

const FILESYSTEM_PERMISSION_PATTERN = /\b(?:EACCES|EPERM|Operation not permitted|Permission denied)\b/i
const PACKAGE_MANAGER_PATH_PATTERN = /(?:^|[/\\.])(?:corepack|npm|pnpm|yarn)(?:$|[/\\.])/i
const WATCHMAN_PATTERN = /\bwatchman\b/i

/**
 * Identifies toolchain and execution-environment failures that happen before tests start.
 *
 * @param {object} result command result
 * @param {string} [result.stdout] captured stdout
 * @param {string} [result.stderr] captured stderr
 * @returns {object|undefined} structured blocker diagnosis
 */
function getCommandBlocker (result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const yarnVersions = output.match(
    /defines "packageManager": "(yarn@[^"]+)"[\s\S]*?current global version of Yarn is ([0-9][0-9.]*)\./i
  )
  if (yarnVersions) {
    return {
      kind: 'package-manager-version-mismatch',
      summary: `The test command did not start because it resolved Yarn ${yarnVersions[2]}, but package.json ` +
        `requires ${yarnVersions[1]}. No Test Optimization conclusion was reached.`,
      recommendation: 'Run the approved command through the project-declared Yarn version, using its configured ' +
        '`yarnPath` or an explicit Corepack Yarn command, then render and approve a fresh plan.',
      signals: getMatchingLines(output, /packageManager|current global version of Yarn/i),
      toolchainBlocked: true,
    }
  }

  if (WATCHMAN_PATTERN.test(output) && FILESYSTEM_PERMISSION_PATTERN.test(output)) {
    return {
      kind: 'watchman-filesystem-blocked',
      summary: 'The execution environment blocked Watchman state access before tests started. No CI wiring or ' +
        'Test Optimization conclusion was reached.',
      recommendation: 'Rerun in an environment where Watchman can access its state directory. If the CI job ' +
        'itself disables Watchman, preserve that exact setting in the replay command.',
      signals: getMatchingLines(output, /watchman|EACCES|EPERM|Operation not permitted|Permission denied/i),
      blockedByExecutionEnvironment: true,
    }
  }

  const permissionLines = getMatchingLines(
    output,
    /EACCES|EPERM|Operation not permitted|Permission denied/i
  )
  if (permissionLines.some(line => PACKAGE_MANAGER_PATH_PATTERN.test(line))) {
    return {
      kind: 'package-manager-filesystem-blocked',
      summary: 'The test command did not start because the package manager could not write to its tool or cache ' +
        'directory in this execution environment. No Test Optimization conclusion was reached.',
      recommendation: 'Rerun with the project package manager already installed and a writable package-manager ' +
        'home or cache directory. Do not interpret this launcher failure as a Test Optimization problem.',
      signals: permissionLines,
      blockedByExecutionEnvironment: true,
    }
  }
}

/**
 * Returns a small de-duplicated set of matching output lines.
 *
 * @param {string} output command output
 * @param {RegExp} pattern interesting-line pattern
 * @returns {string[]} matching lines
 */
function getMatchingLines (output, pattern) {
  const lines = []
  const seen = new Set()
  for (const line of output.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || seen.has(value) || !pattern.test(value)) continue
    seen.add(value)
    lines.push(value)
    if (lines.length === 6) break
  }
  return lines
}

module.exports = { getCommandBlocker }

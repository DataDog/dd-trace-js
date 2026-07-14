'use strict'

const path = require('path')

const { inheritApprovedExecutable } = require('./executable-approval')

const JEST_NO_WATCHMAN_ADJUSTMENT = 'Disable Watchman for local validation to avoid home-directory writes.'

/**
 * Applies semantics-preserving local validation adjustments to a command.
 *
 * @param {object} framework manifest framework entry
 * @param {object} command command to adjust
 * @returns {object} adjusted command
 */
function getLocalValidationCommand (framework, command) {
  if (framework.framework !== 'jest' || command.usesShell || command.argv?.includes('--no-watchman') ||
    !isJestCommand(command.argv)) {
    return command
  }

  const argv = [...command.argv]
  const executable = path.basename(argv[0]).replace(/\.cmd$/i, '')
  if (executable === 'npm' && !argv.includes('--')) argv.push('--')
  argv.push('--no-watchman')

  return inheritApprovedExecutable(command, {
    ...command,
    argv,
    localAdjustments: [
      ...(command.localAdjustments || []),
      JEST_NO_WATCHMAN_ADJUSTMENT,
    ],
  })
}

/**
 * Identifies Jest entrypoints and package scripts that can forward Jest options.
 *
 * @param {string[]} argv command arguments
 * @returns {boolean} whether --no-watchman can be appended safely
 */
function isJestCommand (argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false

  const executable = path.basename(argv[0]).replace(/\.cmd$/i, '')
  if (['npm', 'npx', 'pnpm', 'yarn', 'yarnpkg'].includes(executable)) return true

  return argv.some(argument => /(?:^|[/\\])(?:jest|jest\.js)$/.test(argument))
}

/**
 * Removes Datadog initialization from a command before an uninstrumented preflight.
 *
 * @param {object} command command to sanitize
 * @returns {object} Datadog-clean command
 */
function getDatadogCleanCommand (command) {
  const env = {}
  for (const [name, value] of Object.entries(command.env || {})) {
    if (name.startsWith('DD_') || (name === 'NODE_OPTIONS' && /dd-trace/.test(value))) continue
    env[name] = value
  }

  return inheritApprovedExecutable(command, {
    ...command,
    env,
  })
}

/**
 * Returns the CI wiring command with the replay shell recorded by CI discovery when available.
 *
 * @param {object} framework manifest framework entry
 * @returns {object|undefined} command to run
 */
function getCiWiringCommand (framework) {
  const command = framework.ciWiringCommand
  if (!command || !command.usesShell || command.shell || !framework.ciWiring?.shell) return command

  const replayCommand = getShellReplayCommand(command, framework.ciWiring.shell)
  if (replayCommand) return inheritApprovedExecutable(command, replayCommand)

  const shell = getReplayShell(framework.ciWiring.shell)
  if (!shell) return command

  return inheritApprovedExecutable(command, {
    ...command,
    shell,
  })
}

function getShellReplayCommand (command, shell) {
  const tokens = tokenizeShellTemplate(shell)
  const hasTemplate = tokens.includes('{0}')
  if (tokens.length <= 1 && !hasTemplate) return

  const argv = hasTemplate ? tokens.filter(token => token !== '{0}') : tokens
  if (!isBourneShell(argv[0])) return

  return {
    ...command,
    argv: [...argv, '-c', command.shellCommand],
    shell: undefined,
    shellCommand: undefined,
    usesShell: false,
  }
}

function getReplayShell (shell) {
  const value = String(shell || '').trim()
  if (!value) return

  const firstToken = value.split(/\s+/)[0]
  if (firstToken && value.includes('{0}')) return firstToken
  if (!/\s/.test(value)) return value
}

function tokenizeShellTemplate (shell) {
  return String(shell || '').trim().split(/\s+/).filter(Boolean)
}

function isBourneShell (executable) {
  const basename = path.basename(String(executable || ''))
  return basename === 'bash' || basename === 'sh' || basename === 'zsh'
}

module.exports = {
  getCiWiringCommand,
  getDatadogCleanCommand,
  getLocalValidationCommand,
}

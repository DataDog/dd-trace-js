'use strict'

const path = require('path')

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

  return {
    ...command,
    argv,
    localAdjustments: [
      ...(command.localAdjustments || []),
      JEST_NO_WATCHMAN_ADJUSTMENT,
    ],
  }
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

  return {
    ...command,
    env,
  }
}

module.exports = {
  getDatadogCleanCommand,
  getLocalValidationCommand,
}

'use strict'

/* eslint-disable no-console, eslint-rules/eslint-process-env */

const path = require('path')
const { spawn } = require('child_process')

const { NODE_MAJOR, NODE_MINOR } = require('../../version')
const { prepareCommandOutputs, restoreCommandOutputs } = require('./command-output-policy')
const { sanitizeConsoleText, sanitizeString } = require('./redaction')
const { ensureSafeDirectory, writeFileSafely } = require('./safe-files')

const INIT_PATH = path.resolve(__dirname, '..', 'init.js')
const REGISTER_PATH = path.resolve(__dirname, '..', '..', 'register.js')
const TRANSPORT_PRELOAD_PATH = path.resolve(__dirname, 'transport-preload.js')
const VALIDATION_INTAKE_URL_ENV = 'DD_TEST_OPTIMIZATION_VALIDATION_INTAKE_URL'
const VALIDATION_RESERVED_ENV_NAMES = [
  'DD_AGENT_HOST',
  // Also reject the supported alias so repository commands cannot bypass the fake intake.
  // eslint-disable-next-line eslint-rules/eslint-env-aliases
  'DD_TRACE_AGENT_HOSTNAME',
  'DD_TRACE_AGENT_PORT',
  'DD_TRACE_AGENT_URL',
  'DD_TRACE_AGENT_UNIX_DOMAIN_SOCKET',
  'DD_CIVISIBILITY_AGENTLESS_URL',
  'NODE_OPTIONS',
  VALIDATION_INTAKE_URL_ENV,
]
const CLEAN_ENV_ALLOWLIST = new Set([
  'COMSPEC',
  'ComSpec',
  'HOME',
  'LOGNAME',
  'PATH',
  'Path',
  'PATHEXT',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'VOLTA_HOME',
  'WINDIR',
  'windir',
])
const VALIDATION_SUPPRESSION_ENV = {
  DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
  // Live validation only needs test-cycle events and explicitly configured scenario endpoints.
  // Extra side channels can produce noisy fake-intake traffic or race the final test event flush.
  DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
  DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED: 'false',
  DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: 'false',
  DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE: 'false',
  DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
}
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const EARLY_STOP_KILL_GRACE_MS = 500
const TIMEOUT_KILL_GRACE_MS = 5000
const TIMEOUT_FINALIZE_GRACE_MS = 1000

function runCommand (command, options = {}) {
  const { env = {}, envMode = 'inherit', outDir, label, repositoryRoot, stopWhen, verbose = false } = options
  const artifactRoot = options.artifactRoot || path.dirname(outDir)
  const startedAt = Date.now()
  const timeoutMs = command.timeoutMs || 300_000
  const timeoutKillGraceMs = command.timeoutKillGraceMs || TIMEOUT_KILL_GRACE_MS
  const timeoutFinalizeGraceMs = command.timeoutFinalizeGraceMs || TIMEOUT_FINALIZE_GRACE_MS
  const maxOutputBytes = command.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES
  const result = {
    label,
    command: serializeCommand(command),
    displayCommand: serializeDisplayCommand(command),
    commandDetails: getCommandDetails(command),
    cwd: command.cwd,
    exitCode: null,
    signal: null,
    stoppedEarly: false,
    durationMs: 0,
    timedOut: false,
    stdout: '',
    stdoutTruncated: false,
    stderr: '',
    stderrTruncated: false,
    artifacts: {},
  }

  ensureSafeDirectory(artifactRoot, outDir, 'command artifact directory')
  try {
    assertNoInlineValidationEnvOverrides(command, env)
  } catch (error) {
    return Promise.reject(error)
  }
  const outputStates = prepareCommandOutputs({ command, artifactRoot, outDir, repositoryRoot })

  return new Promise((resolve) => {
    let finalized = false
    let processGroupCleanupPending = false
    let pendingCloseResult
    const childEnv = {
      ...getBaseEnv(envMode),
      ...command.env,
      ...env,
    }
    if (command.env?.NODE_OPTIONS && env.NODE_OPTIONS) {
      childEnv.NODE_OPTIONS = mergeNodeOptions(env.NODE_OPTIONS, command.env.NODE_OPTIONS)
    }

    const useProcessGroup = shouldUseProcessGroup()
    let child
    try {
      child = command.usesShell
        ? spawn(command.shellCommand, {
          cwd: command.cwd,
          detached: useProcessGroup,
          env: childEnv,
          shell: command.shell || true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        : spawn(command.argv[0], command.argv.slice(1), {
          cwd: command.cwd,
          detached: useProcessGroup,
          env: childEnv,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
    } catch (error) {
      result.stderr = `${error.stack || error}\n`
      result.durationMs = Date.now() - startedAt
      try {
        result.commandOutputPaths = restoreCommandOutputs(outputStates)
      } catch (cleanupError) {
        result.outputCleanupError = cleanupError?.message || String(cleanupError)
      }
      resolve(result)
      return
    }

    if (verbose) {
      console.log(sanitizeConsoleText(
        `[test-optimization-validator] running ${label || serializeCommand(command)}`
      ))
    }

    let killTimer
    let finalizeTimer
    let stopTimer
    const timeout = setTimeout(() => {
      result.timedOut = true
      processGroupCleanupPending = useProcessGroup
      signalChild(child, 'SIGTERM', useProcessGroup)
      killTimer = setTimeout(() => {
        signalChild(child, 'SIGKILL', useProcessGroup)
        processGroupCleanupPending = false
        finalizeTimer = setTimeout(() => {
          finalize(pendingCloseResult?.code ?? null, pendingCloseResult?.signal || 'SIGKILL')
        }, timeoutFinalizeGraceMs)
      }, timeoutKillGraceMs)
    }, timeoutMs)

    if (stopWhen) {
      stopTimer = setInterval(() => {
        let shouldStop = false
        try {
          shouldStop = stopWhen()
        } catch {}
        if (!shouldStop) return

        clearInterval(stopTimer)
        result.stoppedEarly = true
        processGroupCleanupPending = useProcessGroup
        signalChild(child, 'SIGTERM', useProcessGroup)
        killTimer = setTimeout(() => {
          signalChild(child, 'SIGKILL', useProcessGroup)
          processGroupCleanupPending = false
          finalizeTimer = setTimeout(() => {
            finalize(pendingCloseResult?.code ?? null, pendingCloseResult?.signal || 'SIGKILL')
          }, timeoutFinalizeGraceMs)
        }, EARLY_STOP_KILL_GRACE_MS)
      }, 25)
    }

    child.stdout.on('data', chunk => {
      const capture = appendCapturedOutput(result.stdout, chunk, maxOutputBytes)
      result.stdout = capture.output
      result.stdoutTruncated = result.stdoutTruncated || capture.truncated
    })
    child.stderr.on('data', chunk => {
      const capture = appendCapturedOutput(result.stderr, chunk, maxOutputBytes)
      result.stderr = capture.output
      result.stderrTruncated = result.stderrTruncated || capture.truncated
    })
    child.on('error', err => {
      result.stderr += `${err.stack || err}\n`
      finalize(null, null)
    })
    child.on('close', (code, signal) => {
      if (processGroupCleanupPending) {
        pendingCloseResult = { code, signal }
        return
      }
      finalize(code, signal)
    })

    function finalize (code, signal) {
      if (finalized) return
      finalized = true
      clearTimeout(timeout)
      clearTimeout(killTimer)
      clearTimeout(finalizeTimer)
      clearInterval(stopTimer)
      result.exitCode = code
      result.signal = signal
      result.durationMs = Date.now() - startedAt

      try {
        result.commandOutputPaths = restoreCommandOutputs(outputStates)
      } catch (err) {
        result.outputCleanupError = err && err.message ? err.message : String(err)
        result.stderr += '\n[test-optimization-validator] could not restore command outputs: ' +
          `${result.outputCleanupError}\n`
        if (result.exitCode === 0) result.exitCode = 1
      }

      result.artifacts.stdout = path.join(outDir, 'stdout.txt')
      result.artifacts.stderr = path.join(outDir, 'stderr.txt')
      result.artifacts.command = path.join(outDir, 'command.json')

      writeFileSafely(
        artifactRoot,
        result.artifacts.stdout,
        sanitizeString(formatCapturedOutput(result.stdout, result.stdoutTruncated, maxOutputBytes)),
        'command stdout artifact'
      )
      writeFileSafely(
        artifactRoot,
        result.artifacts.stderr,
        sanitizeString(formatCapturedOutput(result.stderr, result.stderrTruncated, maxOutputBytes)),
        'command stderr artifact'
      )
      writeFileSafely(artifactRoot, result.artifacts.command, `${JSON.stringify({
        command: sanitizeString(result.command),
        displayCommand: sanitizeString(result.displayCommand),
        commandDetails: result.commandDetails,
        cwd: result.cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stoppedEarly: result.stoppedEarly,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        maxOutputBytes,
        commandOutputPaths: result.commandOutputPaths,
        outputCleanupError: result.outputCleanupError,
      }, null, 2)}\n`, 'command metadata artifact')

      resolve(result)
    }
  })
}

/**
 * Appends output while retaining only the latest bytes for diagnostic artifacts.
 *
 * @param {string} current currently captured output
 * @param {Buffer|string} chunk new output chunk
 * @param {number} maxBytes maximum retained bytes
 * @returns {{output: string, truncated: boolean}} retained output and truncation flag
 */
function appendCapturedOutput (current, chunk, maxBytes) {
  const next = Buffer.concat([
    Buffer.from(current),
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
  ])

  if (next.length <= maxBytes) {
    return {
      output: next.toString('utf8'),
      truncated: false,
    }
  }

  return {
    output: next.subarray(next.length - maxBytes).toString('utf8'),
    truncated: true,
  }
}

/**
 * Adds truncation context to a captured command output artifact.
 *
 * @param {string} output captured output
 * @param {boolean} truncated whether earlier output was omitted
 * @param {number} maxBytes maximum retained bytes
 * @returns {string} output artifact content
 */
function formatCapturedOutput (output, truncated, maxBytes) {
  if (!truncated) return output
  return `[test-optimization-validator] output truncated to last ${maxBytes} bytes\n${output}`
}

function shouldUseProcessGroup () {
  return process.platform !== 'win32'
}

function signalChild (child, signal, useProcessGroup) {
  try {
    if (useProcessGroup) {
      process.kill(-child.pid, signal)
      return
    }
  } catch {}

  child.kill(signal)
}

function getBaseEnv (envMode) {
  if (envMode !== 'clean') return process.env

  const cleanEnv = {}
  for (const name of CLEAN_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) cleanEnv[name] = process.env[name]
  }
  return cleanEnv
}

function buildDatadogEnv ({ intake, scenario, framework, command }) {
  const transport = buildValidationTransportEnv(intake)
  return {
    ...transport,
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '0',
    DD_CIVISIBILITY_ENABLED: '1',
    DD_TRACE_ENABLED: 'true',
    ...VALIDATION_SUPPRESSION_ENV,
    DD_SERVICE: 'dd-test-optimization-validation',
    DD_ENV: 'local-validation',
    DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
    DD_TAGS: `test_optimization.validation.scenario:${scenario}`,
    NODE_OPTIONS: mergeNodeOptions(transport.NODE_OPTIONS, withCiPreloads('', framework, command)),
  }
}

function buildCiWiringEnv ({ intake }) {
  return {
    ...buildValidationTransportEnv(intake),
    DD_TRACE_DEBUG: '1',
    DD_TRACE_LOG_LEVEL: 'debug',
    ...VALIDATION_SUPPRESSION_ENV,
  }
}

/**
 * Builds transport settings that are re-applied inside each Node.js process before dd-trace initializes.
 *
 * @param {{port: number}} intake fake intake
 * @returns {NodeJS.ProcessEnv} validation transport environment
 */
function buildValidationTransportEnv (intake) {
  const url = `http://127.0.0.1:${intake.port}`
  return {
    DD_AGENT_HOST: '127.0.0.1',
    DD_TRACE_AGENT_HOSTNAME: '127.0.0.1',
    DD_TRACE_AGENT_PORT: String(intake.port),
    DD_TRACE_AGENT_URL: url,
    DD_CIVISIBILITY_AGENTLESS_URL: url,
    [VALIDATION_INTAKE_URL_ENV]: url,
    NODE_OPTIONS: `-r ${formatNodeRequire(TRANSPORT_PRELOAD_PATH)}`,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

/**
 * Rejects command-local assignments that can bypass validator-controlled fake-intake routing.
 *
 * @param {object} command command to execute
 * @param {NodeJS.ProcessEnv} env validator environment overrides
 */
function assertNoInlineValidationEnvOverrides (command, env) {
  if (!env[VALIDATION_INTAKE_URL_ENV]) return

  if (command.usesShell) {
    rejectReservedShellAssignments(command.shellCommand)
    return
  }

  const parsed = parseArgv(command.argv)
  rejectReservedEnvSplitStrings(command.argv)
  if (parsed.ignoreEnvironment) throwEnvironmentReset()
  for (const name of Object.keys(parsed.prefixEnv)) {
    if (VALIDATION_RESERVED_ENV_NAMES.includes(name)) throwReservedEnvOverride(name)
  }
  for (const name of parsed.unsetEnvNames) {
    if (VALIDATION_RESERVED_ENV_NAMES.includes(name)) throwReservedEnvOverride(name)
  }

  for (let index = 0; index < command.argv.length - 1; index++) {
    const value = command.argv[index]
    if (value === '-c' && typeof command.argv[index + 1] === 'string') {
      rejectReservedShellAssignments(command.argv[index + 1])
    }
  }
}

/**
 * Rejects reserved variable assignments and removals in shell source.
 *
 * @param {string} shellCommand shell source
 */
function rejectReservedShellAssignments (shellCommand) {
  const source = String(shellCommand || '')
  const environmentReset = /\benv(?:\.exe)?\s+(?:(?![;&|()]).)*?(?:-i\b|--ignore-environment\b)/i

  if (environmentReset.test(source)) throwEnvironmentReset()

  for (const name of VALIDATION_RESERVED_ENV_NAMES) {
    const escapedName = escapeRegExp(name)
    const assignment = new RegExp(
      String.raw`(?:^|[\s;&|()'"])(?:export\s+|set\s+)?(?:\$env:)?${escapedName}\s*=`,
      'i'
    )
    const removal = new RegExp(
      String.raw`(?:\bunset\s+|\benv(?:\.exe)?\s+(?:(?![;&|()]).)*?(?:-u\s*|--unset(?:=|\s+))|` +
      String.raw`\bRemove-Item\s+(?:[^;&|]*\s)?env:)${escapedName}\b`,
      'i'
    )

    if (assignment.test(source) || removal.test(source)) throwReservedEnvOverride(name)
  }
}

/**
 * Rejects reserved environment changes hidden inside env --split-string arguments.
 *
 * @param {string[]} argv structured command arguments
 * @returns {void}
 */
function rejectReservedEnvSplitStrings (argv) {
  if (!Array.isArray(argv) || !isEnvExecutable(argv[0])) return

  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '-S' || argument === '--split-string') {
      if (typeof argv[index + 1] === 'string') rejectReservedShellAssignments(`env ${argv[index + 1]}`)
      index++
      continue
    }

    const splitString = /^--split-string=(.*)$/.exec(argument)?.[1]
    if (splitString !== undefined) rejectReservedShellAssignments(`env ${splitString}`)
  }
}

/**
 * Throws a customer-facing error for unsafe inline validation environment changes.
 *
 * @param {string} name reserved environment variable
 */
function throwReservedEnvOverride (name) {
  throw new Error(
    `Refusing inline ${name} changes during live validation because they can bypass the local fake intake. ` +
    'Record CI-provided values in command.env so the validator can apply safe transport overrides.'
  )
}

function throwEnvironmentReset () {
  throw new Error(
    'Refusing to clear the command environment during live validation because this would remove the local fake ' +
    'intake and Datadog initialization settings.'
  )
}

/**
 * Escapes a literal for use in a regular expression.
 *
 * @param {string} value literal value
 * @returns {string} escaped value
 */
function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function withCiPreloads (nodeOptions = '', framework, command) {
  let result = nodeOptions.trim()

  if (framework?.framework === 'vitest' && supportsImportPreload(command) && !hasRegister(result)) {
    result = `--import ${formatNodeRequire(REGISTER_PATH)}${result ? ` ${result}` : ''}`
  }

  if (!hasCiInit(result)) {
    result = `${result ? `${result} ` : ''}-r ${formatNodeRequire(INIT_PATH)}`
  }

  return result
}

function mergeNodeOptions (...nodeOptions) {
  return nodeOptions
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * Checks whether the command Node.js version supports --import in NODE_OPTIONS.
 *
 * @param {object} [command] test command
 * @returns {boolean} true when --import can be used
 */
function supportsImportPreload (command) {
  const version = getCommandNodeVersion(command)
  if (version) return versionSupportsImportPreload(version)

  if (command) return false
  return versionSupportsImportPreload(`${NODE_MAJOR}.${NODE_MINOR}.0`)
}

/**
 * Resolves the Node.js version for commands that directly execute Node.
 *
 * @param {object} [command] test command
 * @returns {string|undefined} Node.js version
 */
function getCommandNodeVersion (command) {
  if (!command) return
  if (command.usesShell) return process.versions.node
  if (!Array.isArray(command.argv)) return

  const { commandIndex } = parseArgv(command.argv)
  const executable = command.argv[commandIndex]
  if (isNodeExecutable(executable) && path.isAbsolute(executable) &&
    path.resolve(executable) !== path.resolve(process.execPath)) {
    return
  }

  // Do not execute a command-controlled `node` binary just to inspect its version. Package-manager commands
  // normally inherit the validator runtime; explicit alternate Node executables conservatively omit --import.
  return process.versions.node
}

/**
 * Checks whether a Node.js version supports --import in NODE_OPTIONS.
 *
 * @param {string} version Node.js version string
 * @returns {boolean} true when --import can be used
 */
function versionSupportsImportPreload (version) {
  const [major, minor] = String(version).split('.').map(Number)
  if (major > 18) return true
  return major === 18 && minor >= 18
}

function hasCiInit (nodeOptions) {
  return nodeOptions.includes('dd-trace/ci/init') || nodeOptions.includes(INIT_PATH)
}

function hasRegister (nodeOptions) {
  return nodeOptions.includes('dd-trace/register.js') || nodeOptions.includes(REGISTER_PATH)
}

function formatNodeRequire (filename) {
  if (!/\s/.test(filename)) return filename
  return JSON.stringify(filename)
}

function serializeCommand (command) {
  return command.usesShell ? command.shellCommand : command.argv.join(' ')
}

/**
 * Renders the command that will actually execute without trusting display-only manifest fields.
 *
 * @param {object} command command to render
 * @returns {string} unambiguous customer-facing command
 */
function serializeApprovalCommand (command) {
  if (command.usesShell) return command.shellCommand
  return command.argv.map(formatApprovalArgument).join(' ')
}

/**
 * Quotes arguments whose boundaries would otherwise be ambiguous in an approval plan.
 *
 * @param {string} value argument value
 * @returns {string} visible argument
 */
function formatApprovalArgument (value) {
  const argument = String(value)
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(argument) ? argument : JSON.stringify(argument)
}

function serializeDisplayCommand (command) {
  if (typeof command.displayCommand === 'string' && command.displayCommand.trim()) {
    return command.displayCommand.trim()
  }

  if (command.usesShell) return command.shellCommand

  return getDisplayArgv(command.argv).join(' ')
}

function getCommandDetails (command) {
  if (command.usesShell) return

  const details = getDisplayDetails(command.argv)
  if (!details.exactCommandCollapsed) return

  return details
}

function getDisplayArgv (argv) {
  const { prefixAssignments, commandIndex, corepackIndex } = parseArgv(argv)
  if (corepackIndex !== -1) return [...prefixAssignments, ...argv.slice(corepackIndex + 1)]
  return [...prefixAssignments, ...argv.slice(commandIndex)]
}

function getDisplayDetails (argv) {
  const { commandIndex, corepackIndex, pathAdjusted } = parseArgv(argv)
  const displayArgv = getDisplayArgv(argv)
  const details = {
    exactCommandCollapsed: displayArgv.join(' ') !== argv.join(' '),
  }

  if (pathAdjusted) details.pathAdjusted = true

  if (corepackIndex !== -1) {
    details.runtimeWrapper = 'node/corepack'
    details.packageManager = argv[corepackIndex + 1]
  } else if (commandIndex > 0) {
    details.runtimeWrapper = 'env'
  }

  return details
}

function parseArgv (argv) {
  const result = {
    ignoreEnvironment: false,
    prefixAssignments: [],
    prefixEnv: {},
    unsetEnvNames: [],
    commandIndex: 0,
    corepackIndex: -1,
    pathAdjusted: false,
  }

  if (!Array.isArray(argv) || argv.length === 0) return result

  let index = 0
  if (isEnvExecutable(argv[index])) {
    index++
    while (index < argv.length) {
      const option = argv[index]
      if (option === '--') {
        index++
        break
      }
      if (option === '-i' || option === '--ignore-environment') {
        result.ignoreEnvironment = true
        index++
        continue
      }
      if (option === '-u' || option === '--unset') {
        if (typeof argv[index + 1] === 'string') result.unsetEnvNames.push(argv[index + 1])
        index += 2
        continue
      }
      const unsetMatch = /^(?:-u|--unset=)(.+)$/.exec(option)
      if (unsetMatch) {
        result.unsetEnvNames.push(unsetMatch[1])
        index++
        continue
      }
      if (!isEnvAssignment(option)) break

      const assignment = argv[index]
      const equalsIndex = assignment.indexOf('=')
      const name = assignment.slice(0, equalsIndex)
      const value = assignment.slice(equalsIndex + 1)
      result.prefixEnv[name] = value

      if (name === 'PATH') {
        result.pathAdjusted = true
      } else {
        result.prefixAssignments.push(assignment)
      }
      index++
    }
  }

  result.commandIndex = index

  if (isNodeExecutable(argv[index]) && isCorepackScript(argv[index + 1]) && argv[index + 2]) {
    result.corepackIndex = index + 1
  }

  return result
}

function isEnvExecutable (value) {
  const name = getExecutableName(value)
  return name === 'env' || name === 'env.exe'
}

function isEnvAssignment (value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
}

function isNodeExecutable (value = '') {
  const name = getExecutableName(value)
  return name === 'node' || name === 'node.exe'
}

function isCorepackScript (value = '') {
  const name = getExecutableName(value)
  return name === 'corepack' || name === 'corepack.exe' || name === 'corepack.js'
}

function getExecutableName (value = '') {
  return String(value).split(/[\\/]/).pop().toLowerCase()
}

module.exports = {
  runCommand,
  buildCiWiringEnv,
  buildDatadogEnv,
  getBaseEnv,
  getCommandDetails,
  serializeApprovalCommand,
  serializeCommand,
  serializeDisplayCommand,
  withCiPreloads,
  mergeNodeOptions,
}

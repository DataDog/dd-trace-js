'use strict'

/* eslint-disable no-console, eslint-rules/eslint-process-env */

const path = require('path')
const { spawn } = require('child_process')

const {
  cleanupCommandOutputs,
  deferCommandOutputCleanup,
  prepareCommandOutputs,
} = require('./command-output-policy')
const {
  getExecutableForSpawn,
  isEnvExecutable,
  parseArgv,
} = require('./executable')
const { sanitizeConsoleText, sanitizeString } = require('./redaction')
const { ensureSafeDirectory, writeFileSafely } = require('./safe-files')

const INIT_PATH = path.resolve(__dirname, '..', 'init.js')
const REGISTER_PATH = path.resolve(__dirname, '..', '..', 'register.js')
const VALIDATION_MODE_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_MODE'
const VALIDATION_MANIFEST_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE'
const VALIDATION_OUTPUT_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR'
const VALIDATION_CAPTURE_MODE_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_CAPTURE_MODE'
const APM_AGENTLESS_ENV = '_DD_APM_TRACING_AGENTLESS_ENABLED'
const VALIDATION_RESERVED_ENV_NAMES = [
  'NODE_OPTIONS',
  VALIDATION_MANIFEST_ENV,
  VALIDATION_MODE_ENV,
  VALIDATION_OUTPUT_ENV,
  VALIDATION_CAPTURE_MODE_ENV,
  APM_AGENTLESS_ENV,
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
  DD_AGENTLESS_LOG_SUBMISSION_ENABLED: 'false',
  DD_APPSEC_ENABLED: 'false',
  DD_CRASHTRACKING_ENABLED: 'false',
  DD_DATA_STREAMS_ENABLED: 'false',
  DD_DYNAMIC_INSTRUMENTATION_ENABLED: 'false',
  DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED: 'false',
  DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: 'false',
  DD_HEAP_SNAPSHOT_COUNT: '0',
  DD_IAST_ENABLED: 'false',
  DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
  DD_LLMOBS_ENABLED: 'false',
  DD_LOGS_OTEL_ENABLED: 'false',
  DD_METRICS_OTEL_ENABLED: 'false',
  DD_PROFILING_ENABLED: 'false',
  DD_REMOTE_CONFIGURATION_ENABLED: 'false',
  DD_RUNTIME_METRICS_ENABLED: 'false',
  DD_TRACE_OTEL_ENABLED: 'false',
  DD_TRACE_SPAN_LEAK_DEBUG: '0',
  // Offline validation only needs test-cycle events and explicitly configured filesystem inputs.
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
  const {
    env = {},
    envMode = 'inherit',
    deferOutputCleanup = false,
    outDir,
    label,
    repositoryRoot,
    requireExecutableApproval = false,
    stopWhen,
    verbose = false,
  } = options
  const artifactRoot = options.artifactRoot || path.dirname(outDir)
  const startedAt = Date.now()
  const {
    maxOutputBytes,
    timeoutFinalizeGraceMs,
    timeoutKillGraceMs,
    timeoutMs,
  } = getCommandExecutionSettings(command)
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
    stdoutOmittedBytes: 0,
    stdoutTruncated: false,
    stderr: '',
    stderrOmittedBytes: 0,
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
    for (const [name, value] of Object.entries(childEnv)) {
      if (value === undefined) delete childEnv[name]
    }

    const useProcessGroup = shouldUseProcessGroup()
    let child
    try {
      const executable = getExecutableForSpawn(command, { requireApproval: requireExecutableApproval })
      const argv0 = process.platform === 'win32' ? {} : { argv0: executable.argv0 }
      child = command.usesShell
        ? spawn(command.shellCommand, {
          ...argv0,
          cwd: command.cwd,
          detached: useProcessGroup,
          env: childEnv,
          shell: executable.path,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        : spawn(executable.path, command.argv.slice(1), {
          ...argv0,
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
        finishCommandOutputCleanup(result, outputStates, deferOutputCleanup)
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
    let stdoutCapture
    let stderrCapture
    const timeout = setTimeout(() => {
      result.timedOut = true
      processGroupCleanupPending = useProcessGroup
      signalChild(child, 'SIGTERM', useProcessGroup)
      killTimer = setTimeout(() => {
        signalChild(child, 'SIGKILL', useProcessGroup)
        finishProcessGroupCleanup('SIGKILL')
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
          finishProcessGroupCleanup('SIGKILL')
        }, EARLY_STOP_KILL_GRACE_MS)
      }, 25)
    }

    child.stdout.on('data', chunk => {
      const capture = appendCapturedOutput(stdoutCapture, chunk, maxOutputBytes)
      stdoutCapture = capture
      result.stdout = capture.output
      result.stdoutOmittedBytes = capture.omittedBytes
      result.stdoutTruncated = capture.truncated
    })
    child.stderr.on('data', chunk => {
      const capture = appendCapturedOutput(stderrCapture, chunk, maxOutputBytes)
      stderrCapture = capture
      result.stderr = capture.output
      result.stderrOmittedBytes = capture.omittedBytes
      result.stderrTruncated = capture.truncated
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

    function finishProcessGroupCleanup (fallbackSignal) {
      processGroupCleanupPending = false
      if (pendingCloseResult) {
        finalize(pendingCloseResult.code, pendingCloseResult.signal || fallbackSignal)
        return
      }
      finalizeTimer = setTimeout(() => finalize(null, fallbackSignal), timeoutFinalizeGraceMs)
    }

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
        finishCommandOutputCleanup(result, outputStates, deferOutputCleanup)
      } catch (err) {
        result.outputCleanupError = err && err.message ? err.message : String(err)
        result.stderr += '\n[test-optimization-validator] could not clean up command outputs: ' +
          `${result.outputCleanupError}\n`
        if (result.exitCode === 0) result.exitCode = 1
      }

      result.artifacts.stdout = path.join(outDir, 'stdout.txt')
      result.artifacts.stderr = path.join(outDir, 'stderr.txt')
      result.artifacts.command = path.join(outDir, 'command.json')

      try {
        writeFileSafely(
          artifactRoot,
          result.artifacts.stdout,
          sanitizeString(result.stdout),
          'command stdout artifact'
        )
        writeFileSafely(
          artifactRoot,
          result.artifacts.stderr,
          sanitizeString(result.stderr),
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
          stdoutOmittedBytes: result.stdoutOmittedBytes,
          stderrTruncated: result.stderrTruncated,
          stderrOmittedBytes: result.stderrOmittedBytes,
          maxOutputBytes,
          commandOutputPaths: result.commandOutputPaths,
          outputCleanupError: result.outputCleanupError,
        }, null, 2)}\n`, 'command metadata artifact')
      } catch (error) {
        result.artifactWriteError = error?.message || String(error)
        result.stderr += '\n[test-optimization-validator] could not write command artifacts: ' +
          `${result.artifactWriteError}\n`
        if (!Number.isInteger(result.exitCode) || result.exitCode === 0) result.exitCode = 1
      }

      resolve(result)
    }
  })
}

/**
 * Cleans command outputs now or records an opaque handle for a later validation-wide cleanup.
 *
 * @param {object} result command result
 * @param {object[]} outputStates prepared command output state
 * @param {boolean} deferOutputCleanup whether outputs are needed by later commands
 * @returns {void}
 */
function finishCommandOutputCleanup (result, outputStates, deferOutputCleanup) {
  if (deferOutputCleanup && outputStates.length > 0) {
    result.outputCleanupHandle = deferCommandOutputCleanup(outputStates)
    result.commandOutputPaths = outputStates.map(({ outputPath }) => ({ outputPath, action: 'deferred' }))
    return
  }
  result.commandOutputPaths = cleanupCommandOutputs(outputStates)
}

/**
 * Returns the effective bounded execution settings used for one project command.
 *
 * @param {object} command structured command
 * @returns {{maxOutputBytes: number, timeoutFinalizeGraceMs: number, timeoutKillGraceMs: number, timeoutMs: number}}
 * execution settings
 */
function getCommandExecutionSettings (command) {
  return {
    maxOutputBytes: command.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES,
    timeoutFinalizeGraceMs: command.timeoutFinalizeGraceMs || TIMEOUT_FINALIZE_GRACE_MS,
    timeoutKillGraceMs: command.timeoutKillGraceMs || TIMEOUT_KILL_GRACE_MS,
    timeoutMs: command.timeoutMs || 300_000,
  }
}

/**
 * Appends output while retaining only the latest bytes for diagnostic artifacts.
 *
 * @param {object|undefined} current currently captured output state
 * @param {Buffer|string} chunk new output chunk
 * @param {number} maxBytes maximum retained bytes
 * @returns {{output: string, truncated: boolean}} retained output and truncation flag
 */
function appendCapturedOutput (current, chunk, maxBytes) {
  const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const totalBytes = (current?.totalBytes || 0) + nextChunk.length
  const headLimit = Math.floor(maxBytes / 2)
  const tailLimit = maxBytes - headLimit
  let head = current?.head || Buffer.alloc(0)
  let tail

  if (current?.truncated) {
    const combinedTail = Buffer.concat([current.tail, nextChunk])
    tail = combinedTail.subarray(Math.max(0, combinedTail.length - tailLimit))
  } else {
    const combined = Buffer.concat([current?.tail || Buffer.alloc(0), nextChunk])
    if (combined.length <= maxBytes) {
      return {
        head,
        tail: combined,
        totalBytes,
        omittedBytes: 0,
        output: combined.toString('utf8'),
        truncated: false,
      }
    }
    head = combined.subarray(0, headLimit)
    tail = combined.subarray(combined.length - tailLimit)
  }

  const omittedBytes = totalBytes - head.length - tail.length
  return {
    head,
    tail,
    totalBytes,
    omittedBytes,
    output: `${head.toString('utf8')}\n[test-optimization-validator] ${omittedBytes} bytes omitted\n` +
      tail.toString('utf8'),
    truncated: true,
  }
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

function buildDatadogEnv ({ fixture, outputRoot, scenario, framework }) {
  const offline = buildOfflineValidationEnv({ fixture, outputRoot })
  return {
    ...offline,
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '0',
    DD_CIVISIBILITY_ENABLED: '1',
    DD_TRACE_ENABLED: 'true',
    ...VALIDATION_SUPPRESSION_ENV,
    DD_SERVICE: 'dd-test-optimization-validation',
    DD_ENV: 'local-validation',
    DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
    DD_TAGS: `test_optimization.validation.scenario:${scenario}`,
    NODE_OPTIONS: withCiPreloads('', framework),
  }
}

function buildCiWiringEnv ({ fixture, outputRoot }) {
  return {
    ...buildOfflineValidationEnv({ fixture, outputRoot }),
    [VALIDATION_CAPTURE_MODE_ENV]: 'sample',
    DD_TRACE_DEBUG: '1',
    DD_TRACE_LOG_LEVEL: 'debug',
    ...VALIDATION_SUPPRESSION_ENV,
  }
}

/**
 * Builds the private environment used by the filesystem-only validation exporter.
 *
 * @param {object} input offline validation inputs
 * @param {{manifestPath: string}} input.fixture authoritative cache fixture
 * @param {string} input.outputRoot pre-created payload output root
 * @returns {NodeJS.ProcessEnv} validation transport environment
 */
function buildOfflineValidationEnv ({ fixture, outputRoot }) {
  return {
    DD_AGENT_HOST: undefined,
    DD_API_KEY: undefined,
    DD_APP_KEY: undefined,
    DATADOG_API_KEY: undefined,
    [APM_AGENTLESS_ENV]: undefined,
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '0',
    DD_CIVISIBILITY_AGENTLESS_URL: undefined,
    DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE: undefined,
    DD_TRACE_AGENT_HOSTNAME: undefined,
    DD_TRACE_AGENT_PORT: undefined,
    DD_TRACE_AGENT_UNIX_DOMAIN_SOCKET: undefined,
    DD_TRACE_AGENT_URL: undefined,
    OTEL_LOGS_EXPORTER: undefined,
    OTEL_METRICS_EXPORTER: undefined,
    OTEL_TRACES_EXPORTER: undefined,
    [VALIDATION_MANIFEST_ENV]: fixture.manifestPath,
    [VALIDATION_MODE_ENV]: '1',
    [VALIDATION_OUTPUT_ENV]: outputRoot,
  }
}

/**
 * Rejects command-local assignments that can bypass validator-controlled offline routing.
 *
 * @param {object} command command to execute
 * @param {NodeJS.ProcessEnv} env validator environment overrides
 */
function assertNoInlineValidationEnvOverrides (command, env) {
  if (!env[VALIDATION_MODE_ENV]) return
  const reservedEnvNames = new Set([
    ...VALIDATION_RESERVED_ENV_NAMES,
    ...Object.keys(env).filter(name => {
      return name.startsWith('DD_') || name.startsWith('_DD_') || name.startsWith('OTEL_')
    }),
  ])

  if (command.usesShell) {
    rejectReservedShellAssignments(command.shellCommand, reservedEnvNames)
    return
  }

  const parsed = parseArgv(command.argv)
  rejectReservedEnvSplitStrings(command.argv, reservedEnvNames)
  if (parsed.ignoreEnvironment) throwEnvironmentReset()
  if (parsed.unsupportedEnvOption) throwUnsupportedEnvOption(parsed.unsupportedEnvOption)
  for (const name of Object.keys(parsed.prefixEnv)) {
    if (reservedEnvNames.has(name)) throwReservedEnvOverride(name)
  }
  for (const name of parsed.unsetEnvNames) {
    if (reservedEnvNames.has(name)) throwReservedEnvOverride(name)
  }

  if (isPosixShellExecutable(command.argv[parsed.commandIndex])) {
    for (let index = parsed.commandIndex + 1; index < command.argv.length - 1; index++) {
      const value = command.argv[index]
      if (isShellCommandFlag(value) && typeof command.argv[index + 1] === 'string') {
        rejectReservedShellAssignments(command.argv[index + 1], reservedEnvNames)
      }
    }
  }
}

/**
 * Rejects reserved variable assignments and removals in shell source.
 *
 * @param {string} shellCommand shell source
 * @param {Set<string>} reservedEnvNames validator-controlled environment names
 */
function rejectReservedShellAssignments (shellCommand, reservedEnvNames) {
  const source = normalizeShellVariableNames(String(shellCommand || ''))
  const environmentReset =
    /\benv(?:\.exe)?\s+(?:(?![;&|()]).)*?(?:-(?=\s|$)|-i\b|--ignore-environment\b)/i

  if (environmentReset.test(source)) throwEnvironmentReset()

  for (const name of reservedEnvNames) {
    const escapedName = escapeRegExp(name)
    const assignment = new RegExp(
      String.raw`(?:^|[\s;&|()'"])(?:export\s+|set\s+)?(?:\$env:)?${escapedName}\s*\+?=`,
      'i'
    )
    const removal = new RegExp(
      String.raw`(?:\bunset(?:\s+(?:-[A-Za-z]+|[A-Za-z_][A-Za-z0-9_]*))*\s+|` +
      String.raw`\benv(?:\.exe)?\s+(?:(?![;&|()]).)*?(?:-u\s*|--unset(?:=|\s+))|` +
      String.raw`\bRemove-Item\s+(?:[^;&|]*\s)?env:)${escapedName}\b`,
      'i'
    )

    if (assignment.test(source) || removal.test(source)) throwReservedEnvOverride(name)
  }
}

/**
 * Joins quoted identifier fragments so shell quoting cannot hide a reserved variable name.
 *
 * @param {string} source shell source
 * @returns {string} source normalized for assignment-name detection only
 */
function normalizeShellVariableNames (source) {
  let normalized = source
  let previous
  do {
    previous = normalized
    normalized = normalized
      .replaceAll(/(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g, '$2')
      .replaceAll(/([A-Za-z0-9_])['"](?=[A-Za-z0-9_])/g, '$1')
  } while (normalized !== previous)
  return normalized
}

/**
 * Rejects reserved environment changes hidden inside env --split-string arguments.
 *
 * @param {string[]} argv structured command arguments
 * @param {Set<string>} reservedEnvNames validator-controlled environment names
 * @returns {void}
 */
function rejectReservedEnvSplitStrings (argv, reservedEnvNames) {
  if (!Array.isArray(argv) || !isEnvExecutable(argv[0])) return

  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '-S' || argument === '--split-string') {
      if (typeof argv[index + 1] === 'string') {
        rejectReservedShellAssignments(`env ${argv[index + 1]}`, reservedEnvNames)
      }
      index++
      continue
    }

    const splitString = /^(?:-S|--split-string=)(.+)$/.exec(argument)?.[1]
    if (splitString !== undefined) rejectReservedShellAssignments(`env ${splitString}`, reservedEnvNames)
  }
}

function isShellCommandFlag (value) {
  return /^-[A-Za-z]*c[A-Za-z]*$/.test(value)
}

function isPosixShellExecutable (value) {
  return /^(?:a|ba|da|k|z)?sh$/.test(path.basename(String(value || '')).toLowerCase())
}

/**
 * Throws a customer-facing error for unsafe inline validation environment changes.
 *
 * @param {string} name reserved environment variable
 */
function throwReservedEnvOverride (name) {
  throw new Error(
    `Refusing inline ${name} changes during live validation because they can bypass the offline validation mode. ` +
    'Record CI-provided values in command.env so the validator can apply its private diagnostic settings.'
  )
}

function throwEnvironmentReset () {
  throw new Error(
    'Refusing to clear the command environment during live validation because this would remove the offline ' +
    'validation and Datadog initialization settings.'
  )
}

function throwUnsupportedEnvOption (option) {
  throw new Error(
    `Refusing unsupported env option ${option} during live validation because its environment effects cannot be ` +
    'verified safely.'
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

function withCiPreloads (nodeOptions = '', framework) {
  let result = nodeOptions.trim()

  if (framework?.framework === 'vitest' && !hasRegister(result)) {
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
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(argument)) return argument
  if (process.platform === 'win32') return JSON.stringify(argument)
  return `'${argument.replaceAll('\'', String.raw`'"'"'`)}'`
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

module.exports = {
  runCommand,
  buildCiWiringEnv,
  buildDatadogEnv,
  getBaseEnv,
  getCommandDetails,
  getCommandExecutionSettings,
  serializeApprovalCommand,
  serializeCommand,
  serializeDisplayCommand,
  withCiPreloads,
  mergeNodeOptions,
}

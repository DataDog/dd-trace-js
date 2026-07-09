'use strict'

/* eslint-disable no-console, eslint-rules/eslint-process-env */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const { sanitizeString } = require('./redaction')

const INIT_PATH = path.resolve(__dirname, '..', 'init.js')
const REGISTER_PATH = path.resolve(__dirname, '..', '..', 'register.js')
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
const TIMEOUT_KILL_GRACE_MS = 5000
const TIMEOUT_FINALIZE_GRACE_MS = 1000

function runCommand (command, { env = {}, envMode = 'inherit', outDir, label, verbose = false } = {}) {
  const startedAt = Date.now()
  const timeoutMs = command.timeoutMs || 300_000
  const timeoutKillGraceMs = command.timeoutKillGraceMs || TIMEOUT_KILL_GRACE_MS
  const timeoutFinalizeGraceMs = command.timeoutFinalizeGraceMs || TIMEOUT_FINALIZE_GRACE_MS
  const result = {
    label,
    command: serializeCommand(command),
    displayCommand: serializeDisplayCommand(command),
    commandDetails: getCommandDetails(command),
    cwd: command.cwd,
    exitCode: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    artifacts: {},
  }

  fs.mkdirSync(outDir, { recursive: true })

  return new Promise((resolve) => {
    let finalized = false
    let processGroupCleanupPending = false
    let timedOutCloseResult
    const childEnv = {
      ...getBaseEnv(envMode),
      ...command.env,
      ...env,
    }
    if (command.env?.NODE_OPTIONS && env.NODE_OPTIONS) {
      childEnv.NODE_OPTIONS = mergeNodeOptions(command.env.NODE_OPTIONS, env.NODE_OPTIONS)
    }

    const useProcessGroup = shouldUseProcessGroup(command)
    const child = command.usesShell
      ? spawn(command.shellCommand, {
        cwd: command.cwd,
        detached: useProcessGroup,
        env: childEnv,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      : spawn(command.argv[0], command.argv.slice(1), {
        cwd: command.cwd,
        env: childEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

    if (verbose) {
      console.log(`[test-optimization-validator] running ${label || serializeCommand(command)}`)
    }

    let killTimer
    let finalizeTimer
    const timeout = setTimeout(() => {
      result.timedOut = true
      processGroupCleanupPending = useProcessGroup
      signalChild(child, 'SIGTERM', useProcessGroup)
      killTimer = setTimeout(() => {
        signalChild(child, 'SIGKILL', useProcessGroup)
        processGroupCleanupPending = false
        finalizeTimer = setTimeout(() => {
          finalize(timedOutCloseResult?.code ?? null, timedOutCloseResult?.signal || 'SIGKILL')
        }, timeoutFinalizeGraceMs)
      }, timeoutKillGraceMs)
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      result.stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      result.stderr += chunk.toString('utf8')
    })
    child.on('error', err => {
      result.stderr += `${err.stack || err}\n`
      finalize(null, null)
    })
    child.on('close', (code, signal) => {
      if (processGroupCleanupPending) {
        timedOutCloseResult = { code, signal }
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
      result.exitCode = code
      result.signal = signal
      result.durationMs = Date.now() - startedAt

      result.artifacts.stdout = path.join(outDir, 'stdout.txt')
      result.artifacts.stderr = path.join(outDir, 'stderr.txt')
      result.artifacts.command = path.join(outDir, 'command.json')

      fs.writeFileSync(result.artifacts.stdout, sanitizeString(result.stdout))
      fs.writeFileSync(result.artifacts.stderr, sanitizeString(result.stderr))
      fs.writeFileSync(result.artifacts.command, `${JSON.stringify({
        command: sanitizeString(result.command),
        displayCommand: sanitizeString(result.displayCommand),
        commandDetails: result.commandDetails,
        cwd: result.cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      }, null, 2)}\n`)

      resolve(result)
    }
  })
}

function shouldUseProcessGroup (command) {
  return command.usesShell === true && process.platform !== 'win32'
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

function buildDatadogEnv ({ intake, scenario, framework }) {
  return {
    DD_TRACE_AGENT_PORT: String(intake.port),
    DD_TRACE_AGENT_URL: `http://127.0.0.1:${intake.port}`,
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '0',
    DD_CIVISIBILITY_ENABLED: '1',
    DD_TRACE_ENABLED: 'true',
    ...VALIDATION_SUPPRESSION_ENV,
    DD_SERVICE: 'dd-test-optimization-validation',
    DD_ENV: 'local-validation',
    DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
    DD_TAGS: `test_optimization.validation.scenario:${scenario}`,
    NODE_OPTIONS: withCiPreloads(process.env.NODE_OPTIONS, framework),
  }
}

function buildCiWiringEnv ({ intake }) {
  return {
    DD_TRACE_AGENT_PORT: String(intake.port),
    DD_TRACE_AGENT_URL: `http://127.0.0.1:${intake.port}`,
    DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${intake.port}`,
    DD_TRACE_DEBUG: '1',
    DD_TRACE_LOG_LEVEL: 'debug',
    ...VALIDATION_SUPPRESSION_ENV,
  }
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
    prefixAssignments: [],
    commandIndex: 0,
    corepackIndex: -1,
    pathAdjusted: false,
  }

  if (!Array.isArray(argv) || argv.length === 0) return result

  let index = 0
  if (isEnvExecutable(argv[index])) {
    index++
    while (index < argv.length && isEnvAssignment(argv[index])) {
      if (argv[index].startsWith('PATH=')) {
        result.pathAdjusted = true
      } else {
        result.prefixAssignments.push(argv[index])
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
  serializeCommand,
  serializeDisplayCommand,
  withCiPreloads,
  mergeNodeOptions,
}

'use strict'

/* eslint-disable no-console, eslint-rules/eslint-process-env */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const INIT_PATH = path.resolve(__dirname, '..', 'init.js')
const REGISTER_PATH = path.resolve(__dirname, '..', '..', 'register.js')

function runCommand (command, { env = {}, outDir, label, verbose = false } = {}) {
  const startedAt = Date.now()
  const timeoutMs = command.timeoutMs || 300_000
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
    const childEnv = {
      ...process.env,
      ...command.env,
      ...env,
    }
    if (command.env?.NODE_OPTIONS && env.NODE_OPTIONS) {
      childEnv.NODE_OPTIONS = mergeNodeOptions(command.env.NODE_OPTIONS, env.NODE_OPTIONS)
    }

    const child = command.usesShell
      ? spawn(command.shellCommand, {
        cwd: command.cwd,
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

    const timeout = setTimeout(() => {
      result.timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      result.stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      result.stderr += chunk.toString('utf8')
    })
    child.on('error', err => {
      result.stderr += `${err.stack || err}\n`
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      result.exitCode = code
      result.signal = signal
      result.durationMs = Date.now() - startedAt

      result.artifacts.stdout = path.join(outDir, 'stdout.txt')
      result.artifacts.stderr = path.join(outDir, 'stderr.txt')
      result.artifacts.command = path.join(outDir, 'command.json')

      fs.writeFileSync(result.artifacts.stdout, result.stdout)
      fs.writeFileSync(result.artifacts.stderr, result.stderr)
      fs.writeFileSync(result.artifacts.command, `${JSON.stringify({
        command: result.command,
        displayCommand: result.displayCommand,
        commandDetails: result.commandDetails,
        cwd: result.cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      }, null, 2)}\n`)

      resolve(result)
    })
  })
}

function buildDatadogEnv ({ intake, scenario, framework }) {
  return {
    DD_TRACE_AGENT_PORT: String(intake.port),
    DD_TRACE_AGENT_URL: `http://127.0.0.1:${intake.port}`,
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '0',
    DD_CIVISIBILITY_ENABLED: '1',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    DD_SERVICE: 'dd-test-optimization-validation',
    DD_ENV: 'local-validation',
    DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
    DD_TAGS: `test_optimization.validation.scenario:${scenario}`,
    NODE_OPTIONS: withCiPreloads(process.env.NODE_OPTIONS, framework),
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
  if (corepackIndex !== -1) return prefixAssignments.concat(argv.slice(corepackIndex + 1))
  return prefixAssignments.concat(argv.slice(commandIndex))
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
  return value === 'env' || value.endsWith('/env')
}

function isEnvAssignment (value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
}

function isNodeExecutable (value = '') {
  return value === 'node' || value.endsWith('/node')
}

function isCorepackScript (value = '') {
  return value === 'corepack' || value.endsWith('/corepack') || value.endsWith('/corepack.js')
}

module.exports = {
  runCommand,
  buildDatadogEnv,
  getCommandDetails,
  serializeCommand,
  serializeDisplayCommand,
  withCiPreloads,
  mergeNodeOptions,
}

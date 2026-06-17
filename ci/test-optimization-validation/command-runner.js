'use strict'

/* eslint-disable no-console, eslint-rules/eslint-process-env */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const INIT_PATH = path.resolve(__dirname, '..', 'init.js')

function runCommand (command, { env = {}, outDir, label, verbose = false } = {}) {
  const startedAt = Date.now()
  const timeoutMs = command.timeoutMs || 300_000
  const result = {
    label,
    command: serializeCommand(command),
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

function buildDatadogEnv ({ intake, scenario }) {
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
    NODE_OPTIONS: withCiInit(process.env.NODE_OPTIONS),
  }
}

function withCiInit (nodeOptions = '') {
  const existing = nodeOptions
  if (existing.includes('dd-trace/ci/init') || existing.includes(INIT_PATH)) {
    return existing
  }
  return `${existing} -r ${formatNodeRequire(INIT_PATH)}`.trim()
}

function formatNodeRequire (filename) {
  if (!/\s/.test(filename)) return filename
  return JSON.stringify(filename)
}

function serializeCommand (command) {
  return command.usesShell ? command.shellCommand : command.argv.join(' ')
}

module.exports = { runCommand, buildDatadogEnv, serializeCommand }

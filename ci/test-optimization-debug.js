#!/usr/bin/env node
'use strict'

/* eslint-disable no-console, eslint-rules/eslint-process-env */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const {
  runDiagnosis,
} = require('./diagnose')
const {
  openHtmlReport,
} = require('./test-optimization-analyze-intake')
const {
  analyzeIntakeArtifact,
  renderAnalysisText,
} = require('./test-optimization-intake-analysis')
const {
  renderFinalReport,
} = require('./test-optimization-render-report')
const {
  normalizeKnownTests,
  startIntake,
  stopIntake,
} = require('./test-optimization-intake')

const ARTIFACTS = {
  agentJsonReport: 'dd-test-optimization-agent-report.json',
  agentReport: 'dd-test-optimization-agent-report.txt',
  env: 'dd-test-optimization-env.txt',
  finalReport: 'dd-test-optimization-final-report.txt',
  html: 'dd-test-optimization-report.html',
  intake: 'dd-test-optimization-intake.json',
  static: 'dd-test-optimization-static.json',
  testCommand: 'dd-test-optimization-test-command.txt',
  testExitCode: 'dd-test-optimization-test-exit-code.txt',
  testOutput: 'dd-test-optimization-test-output.txt',
  testResult: 'dd-test-optimization-test-result.txt',
}
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}${String.raw`\[[0-?]*[ -/]*[@-~]`}`, 'g')
const DEFAULT_READY_TIMEOUT_MS = 5000
const READY_RETRY_INTERVAL_MS = 50

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    clean: true,
    open: true,
    service: 'dd-test-optimization-debug',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--test-command') {
      options.testCommand = args[++i]
    } else if (arg.startsWith('--test-command=')) {
      options.testCommand = arg.slice('--test-command='.length)
    } else if (arg === '--service') {
      options.service = args[++i]
    } else if (arg.startsWith('--service=')) {
      options.service = arg.slice('--service='.length)
    } else if (arg === '--out-dir') {
      options.outDir = args[++i]
    } else if (arg.startsWith('--out-dir=')) {
      options.outDir = arg.slice('--out-dir='.length)
    } else if (arg === '--ready-timeout-ms') {
      options.readyTimeoutMs = Number(args[++i])
    } else if (arg.startsWith('--ready-timeout-ms=')) {
      options.readyTimeoutMs = Number(arg.slice('--ready-timeout-ms='.length))
    } else if (arg === '--settings-mode') {
      options.settingsMode = args[++i]
    } else if (arg.startsWith('--settings-mode=')) {
      options.settingsMode = arg.slice('--settings-mode='.length)
    } else if (arg === '--known-tests') {
      options.knownTests = normalizeKnownTests(readJsonFile(args[++i]))
    } else if (arg.startsWith('--known-tests=')) {
      options.knownTests = normalizeKnownTests(readJsonFile(arg.slice('--known-tests='.length)))
    } else if (arg === '--no-clean') {
      options.clean = false
    } else if (arg === '--no-open') {
      options.open = false
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      options.unknown = arg
    }
  }

  return options
}

/**
 * Gets CLI help text.
 *
 * @returns {string} help text
 */
function getHelpText () {
  return [
    'Usage: dd-trace-ci-debug --test-command <command> [--service <name>] [--out-dir <dir>]',
    '',
    'Runs the Test Optimization debug flow end-to-end:',
    'static diagnosis, local fake intake, selected test command, analyzer, and final report.',
    '',
    'Options:',
    '  --test-command <command>  Exact test command to run, for example "npm test -- test/foo.spec.js".',
    '  --service <name>          DD_SERVICE value for the debug run. Defaults to dd-test-optimization-debug.',
    '  --out-dir <dir>           Artifact directory. Defaults to the current directory.',
    '  --ready-timeout-ms <ms>   Time to wait for the fake intake /health endpoint. Defaults to 5000.',
    '  --settings-mode <mode>    Fake settings mode: basic-reporting or efd.',
    '  --known-tests <file>      Known tests JSON to return for EFD/debug runs.',
    '  --no-clean                Keep prior debug artifacts before running.',
    '  --no-open                 Skip the best-effort local HTML open attempt.',
  ].join('\n')
}

/**
 * Runs the wrapper.
 *
 * @param {object} options wrapper options
 * @param {Function} callback called with (error, report)
 */
function runDebug (options, callback) {
  const root = process.cwd()
  const outDir = path.resolve(options.outDir || '.')
  const artifacts = getArtifactPaths(outDir)

  if (!options.testCommand) {
    callback(new Error('Missing --test-command.'))
    return
  }

  if (options.clean) {
    cleanArtifacts(artifacts)
  }

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(artifacts.testCommand, `${options.testCommand}\n`)

  const staticReport = runDiagnosis({ root })
  fs.writeFileSync(artifacts.static, `${JSON.stringify(staticReport, null, 2)}\n`)

  startIntake({
    knownTests: options.knownTests,
    out: artifacts.intake,
    html: artifacts.html,
    settingsMode: options.settingsMode,
  }, (startError, intake) => {
    if (startError) {
      callback(startError)
      return
    }

    const env = getTestEnv(options, intake, staticReport)
    const readyTimeoutMs = getReadyTimeoutMs(options)
    writeEnvFile(artifacts.env, env)

    waitForIntakeReady(intake.url, readyTimeoutMs, (readyError) => {
      if (readyError) {
        stopIntake(intake, () => {
          callback(readyError)
        })
        return
      }

      runTestCommand(options.testCommand, root, env, (result) => {
        const output = `${result.stdout || ''}${result.stderr || ''}`
        fs.writeFileSync(artifacts.testOutput, output)
        fs.writeFileSync(artifacts.testExitCode, `${getSpawnExitCode(result)}\n`)
        fs.writeFileSync(artifacts.testResult, `${getTestResult(output)}\n`)

        if (output && !options.silent) {
          console.log(output.trimEnd())
        }

        stopIntake(intake, () => {
          const intakeArtifact = JSON.parse(fs.readFileSync(artifacts.intake, 'utf8'))
          const analysis = analyzeIntakeArtifact(intakeArtifact)
          const openAttempt = options.open ? openHtmlReport(analysis) : undefined
          let analyzerText = renderAnalysisText(analysis)

          if (openAttempt) {
            analyzerText = `${analyzerText}\n\n${openAttempt}`
          }

          fs.writeFileSync(artifacts.agentReport, `${analyzerText}\n`)
          fs.writeFileSync(artifacts.agentJsonReport, `${JSON.stringify({
            ...analysis,
            openAttempt,
          }, null, 2)}\n`)

          const finalReport = renderFinalReport({
            agentJsonReport: artifacts.agentJsonReport,
            agentReport: artifacts.agentReport,
            envFile: artifacts.env,
            intake: artifacts.intake,
            out: artifacts.finalReport,
            static: artifacts.static,
            testCommandFile: artifacts.testCommand,
            testExitCodeFile: artifacts.testExitCode,
            testResultFile: artifacts.testResult,
          })

          fs.writeFileSync(artifacts.finalReport, `${finalReport}\n`)
          callback(undefined, finalReport)
        })
      })
    })
  })
}

/**
 * Reads a JSON file.
 *
 * @param {string} file JSON file path
 * @returns {unknown} parsed JSON
 */
function readJsonFile (file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

/**
 * Gets the fake intake readiness timeout.
 *
 * @param {object} options wrapper options
 * @returns {number} readiness timeout in milliseconds
 */
function getReadyTimeoutMs (options) {
  if (Number.isFinite(options.readyTimeoutMs) && options.readyTimeoutMs > 0) {
    return options.readyTimeoutMs
  }

  return DEFAULT_READY_TIMEOUT_MS
}

/**
 * Waits until the fake intake can handle loopback requests.
 *
 * @param {string} baseUrl intake base URL
 * @param {number} timeoutMs readiness timeout in milliseconds
 * @param {Function} callback called with an error when readiness fails
 */
function waitForIntakeReady (baseUrl, timeoutMs, callback) {
  const deadline = Date.now() + timeoutMs
  const healthUrl = new URL('/health', baseUrl)

  poll()

  function poll () {
    let settled = false
    const req = http.get(healthUrl, res => {
      res.resume()
      res.once('end', () => {
        if (res.statusCode === 200) {
          finish()
        } else {
          retry(new Error(`status ${res.statusCode}`))
        }
      })
    })

    req.setTimeout(Math.min(1000, timeoutMs), () => {
      req.destroy(new Error('request timed out'))
    })
    req.once('error', retry)

    function finish () {
      if (settled) return
      settled = true
      callback()
    }

    function retry (error) {
      if (settled) return
      settled = true

      if (Date.now() >= deadline) {
        callback(new Error(`Fake intake did not become ready at ${healthUrl.href}: ${error.message}`))
        return
      }

      setTimeout(poll, READY_RETRY_INTERVAL_MS)
    }
  }
}

/**
 * Runs the selected test command while keeping the wrapper event loop free for the fake intake.
 *
 * @param {string} testCommand selected test command
 * @param {string} cwd working directory
 * @param {object} env environment overrides
 * @param {Function} callback called with a child-process-like result
 */
function runTestCommand (testCommand, cwd, env, callback) {
  const child = spawn(testCommand, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  let called = false

  child.stdout.on('data', chunk => {
    stdout.push(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr.push(chunk)
  })
  child.once('error', error => {
    finish({
      error,
      stderr: `${Buffer.concat(stderr).toString('utf8')}${error.message}\n`,
      stdout: Buffer.concat(stdout).toString('utf8'),
    })
  })
  child.once('close', (status, signal) => {
    finish({
      signal,
      status,
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdout: Buffer.concat(stdout).toString('utf8'),
    })
  })

  function finish (result) {
    if (called) return
    called = true
    callback(result)
  }
}

/**
 * Gets artifact paths.
 *
 * @param {string} outDir artifact directory
 * @returns {object} artifact paths
 */
function getArtifactPaths (outDir) {
  const artifacts = {}

  for (const [key, file] of Object.entries(ARTIFACTS)) {
    artifacts[key] = path.join(outDir, file)
  }

  return artifacts
}

/**
 * Removes prior artifacts.
 *
 * @param {object} artifacts artifact paths
 */
function cleanArtifacts (artifacts) {
  for (const file of Object.values(artifacts)) {
    fs.rmSync(file, { force: true })
  }
}

/**
 * Gets the test process environment.
 *
 * @param {object} options wrapper options
 * @param {object} intake running fake intake
 * @param {object} staticReport static diagnosis report
 * @returns {object} environment overrides
 */
function getTestEnv (options, intake, staticReport) {
  return {
    DD_API_KEY: 'debug',
    DD_SERVICE: options.service,
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
    DD_CIVISIBILITY_AGENTLESS_URL: intake.url,
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    NODE_OPTIONS: getNodeOptions(staticReport, options.testCommand),
  }
}

/**
 * Gets the NODE_OPTIONS preload for the selected framework.
 *
 * @param {object} staticReport static diagnosis report
 * @param {string} testCommand selected test command
 * @returns {string} NODE_OPTIONS value
 */
function getNodeOptions (staticReport, testCommand) {
  const existing = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''

  if (isVitestRun(staticReport, testCommand)) {
    return `${existing}--import dd-trace/register.js -r dd-trace/ci/init`
  }

  return `${existing}-r dd-trace/ci/init`
}

/**
 * Checks whether the selected command appears to be a Vitest run.
 *
 * @param {object} staticReport static diagnosis report
 * @param {string} testCommand selected test command
 * @returns {boolean} true when Vitest-specific registration should be used
 */
function isVitestRun (staticReport, testCommand) {
  const frameworks = Array.isArray(staticReport.supportedFrameworks) ? staticReport.supportedFrameworks : []
  const commandText = `${testCommand || ''}\n${getNpmScript(testCommand)}`

  if (/\bvitest\b/i.test(commandText)) return true

  return frameworks.length === 1 && frameworks[0].id === 'vitest'
}

/**
 * Gets the npm script body for the selected command, when it is a simple npm script command.
 *
 * @param {string} testCommand selected test command
 * @returns {string} npm script body
 */
function getNpmScript (testCommand) {
  const scriptName = getNpmScriptName(testCommand || '')
  if (!scriptName) return ''

  try {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    return packageJson.scripts?.[scriptName] || ''
  } catch {
    return ''
  }
}

/**
 * Gets the npm script name from a simple npm command.
 *
 * @param {string} testCommand selected test command
 * @returns {string|undefined} npm script name
 */
function getNpmScriptName (testCommand) {
  const npmRunMatch = testCommand.match(/\bnpm\s+run\s+([^\s]+)/)
  if (npmRunMatch) return npmRunMatch[1]

  if (/\bnpm\s+test\b/.test(testCommand)) return 'test'
}

/**
 * Writes env vars to a file.
 *
 * @param {string} file env file path
 * @param {object} env env vars
 */
function writeEnvFile (file, env) {
  const lines = []

  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${value}`)
  }

  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

/**
 * Gets the test command exit code.
 *
 * @param {object} result spawnSync result
 * @returns {number|string} exit code
 */
function getSpawnExitCode (result) {
  if (typeof result.status === 'number') return result.status
  if (result.error) return result.error.code || 1

  return 1
}

/**
 * Extracts a one-line test result from runner output.
 *
 * @param {string} output test output
 * @returns {string} test result
 */
function getTestResult (output) {
  const lines = output.split(/\r?\n/)
    .map(line => stripAnsi(line).trim())
    .filter(Boolean)
  const jestResult = getJestTestResult(lines)

  if (jestResult) return jestResult

  return lines.reverse().find(line => /\b\d+\s+(passing|failing|failed|passed|pending|skipped)\b/i.test(line) ||
    /\b\d+\s+tests?\s+(passed|failed|skipped)\b/i.test(line)) || 'unknown'
}

/**
 * Strips terminal formatting from test output lines.
 *
 * @param {string} value terminal output line
 * @returns {string} line without ANSI escape sequences
 */
function stripAnsi (value) {
  return value.replaceAll(ANSI_ESCAPE_RE, '')
}

/**
 * Extracts a Jest summary from cleaned test output lines.
 *
 * @param {string[]} lines cleaned output lines
 * @returns {string|undefined} short Jest result summary
 */
function getJestTestResult (lines) {
  const testsLine = lines.find(line => /^Tests:\s+/i.test(line))
  if (!testsLine) return

  const testParts = getJestCountParts(testsLine, 'test')
  if (testParts.length === 0) return

  const suitesLine = lines.find(line => /^Test Suites:\s+/i.test(line))
  const suiteParts = suitesLine ? getJestCountParts(suitesLine, 'suite') : []
  if (suiteParts.length === 0) return testParts.join(', ')

  return `${testParts.join(', ')} (${suiteParts.join(', ')})`
}

/**
 * Extracts status counts from a Jest summary line.
 *
 * @param {string} line cleaned Jest summary line
 * @param {string} noun singular noun for the summarized item
 * @returns {string[]} formatted count parts
 */
function getJestCountParts (line, noun) {
  const parts = []
  const statuses = ['failed', 'passed', 'skipped', 'pending', 'todo']

  for (const status of statuses) {
    const match = line.match(new RegExp(String.raw`\b(\d+)\s+${status}\b`, 'i'))
    if (!match) continue

    parts.push(`${match[1]} ${pluralize(Number(match[1]), noun)} ${status}`)
  }

  return parts
}

/**
 * Pluralizes a short noun for a count.
 *
 * @param {number} count item count
 * @param {string} noun singular noun
 * @returns {string} singular or plural noun
 */
function pluralize (count, noun) {
  return count === 1 ? noun : `${noun}s`
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(getHelpText())
  } else if (options.unknown) {
    console.error(`Unknown argument: ${options.unknown}`)
    console.error(getHelpText())
    process.exitCode = 1
  } else {
    runDebug(options, (error, report) => {
      if (error) {
        console.error(error.message)
        process.exitCode = 1
        return
      }

      console.log(report)
    })
  }
}

module.exports = {
  getNodeOptions,
  getTestResult,
  isVitestRun,
  parseArgs,
  runDebug,
}

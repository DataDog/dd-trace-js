'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  mergeNodeOptions,
  runCommand,
} = require('./command-runner')
const { isEnvExecutable, parseArgv } = require('./executable')
const { inheritApprovedExecutable } = require('./executable-approval')
const { sanitizeForReport } = require('./redaction')
const { createFileSafely, ensureSafeDirectory, writeFileSafely } = require('./safe-files')

const PROBE_PRELOAD = path.join(__dirname, 'init-probe-preload.js')
const PROBE_FILE_ENV = 'DD_TEST_OPTIMIZATION_INIT_PROBE_FILE'
const MAX_PROBE_RECORD_BYTES = 1024 * 1024
const DATADOG_PRELOAD_PATTERN = /(?:^|[/\\])dd-trace(?:[/\\](?:ci[/\\]init(?:\.js)?|register\.js))?$/
const DATADOG_PRELOAD_PATHS = new Set([
  path.resolve(__dirname, '..', 'init.js'),
  path.resolve(__dirname, '..', '..', 'register.js'),
].map(normalizePath))

/**
 * Runs a CI-shaped command with a lightweight NODE_OPTIONS preload that records process reachability.
 *
 * @param {object} options probe options
 * @param {object} options.command manifest command to run
 * @param {object} options.framework manifest framework entry
 * @param {string} options.outDir scenario output directory
 * @param {object} options.options CLI options
 * @returns {Promise<{ artifacts: object, summary: object }>} probe artifacts and summary
 */
async function runInitializationProbe ({ command, framework, outDir, options }) {
  const probeOutDir = path.join(outDir, 'initialization-probe')
  const recordsPath = path.join(probeOutDir, 'records.ndjson')
  const rawRecordsPath = path.join(probeOutDir, '.records.raw.ndjson')
  const probeCommand = getProbeCommand(command)

  ensureSafeDirectory(outDir, probeOutDir, 'initialization probe artifact directory')
  createFileSafely(outDir, rawRecordsPath, '', 'raw initialization probe records')

  let result
  let records
  try {
    result = await runCommand(probeCommand, {
      artifactRoot: outDir,
      env: {
        [PROBE_FILE_ENV]: rawRecordsPath,
        NODE_OPTIONS: mergeNodeOptions(
          `-r ${formatNodeRequire(PROBE_PRELOAD)}`
        ),
      },
      envMode: 'clean',
      outDir: probeOutDir,
      repositoryRoot: options.repositoryRoot,
      requireExecutableApproval: options.requireExecutableApproval,
      label: `${framework.id}:ci-wiring:init-probe`,
      stopWhen: () => probeReachedFramework(rawRecordsPath, framework.framework),
      verbose: options.verbose,
    })
    records = readProbeRecords(rawRecordsPath)
    writeFileSafely(
      outDir,
      recordsPath,
      records.map(record => JSON.stringify(sanitizeForReport(record))).join('\n') + '\n',
      'initialization probe records'
    )
  } finally {
    fs.rmSync(rawRecordsPath, { force: true })
  }

  return {
    artifacts: {
      command: result.artifacts.command,
      records: recordsPath,
      stderr: result.artifacts.stderr,
      stdout: result.artifacts.stdout,
    },
    summary: summarizeProbeResult({ framework, result, records, recordsPath }),
  }
}

function getProbeCommand (command) {
  const env = { ...command.env }
  const nodeOptions = []
  if (env.NODE_OPTIONS) nodeOptions.push(removeDatadogNodeOptions(env.NODE_OPTIONS))
  delete env.NODE_OPTIONS

  const probeCommand = {
    ...command,
    env,
  }
  if (command.usesShell) {
    const inline = removeInlineShellNodeOptions(command.shellCommand)
    probeCommand.shellCommand = inline.command
    nodeOptions.push(...inline.nodeOptions)
  } else if (isEnvExecutable(command.argv?.[0])) {
    const inline = removeInlineArgvNodeOptions(command.argv)
    probeCommand.argv = inline.argv
    nodeOptions.push(...inline.nodeOptions)
  }
  const preservedNodeOptions = mergeNodeOptions(...nodeOptions)
  if (preservedNodeOptions) probeCommand.env.NODE_OPTIONS = preservedNodeOptions

  return inheritApprovedExecutable(command, probeCommand)
}

/**
 * Removes env-wrapped NODE_OPTIONS assignments while retaining their non-Datadog values.
 *
 * @param {string[]} argv command arguments
 * @returns {{argv: string[], nodeOptions: string[]}} rewritten arguments and preserved options
 */
function removeInlineArgvNodeOptions (argv) {
  const { commandIndex } = parseArgv(argv)
  const sanitized = []
  const nodeOptions = []
  for (let index = 0; index < argv.length; index++) {
    if (index < commandIndex && /^NODE_OPTIONS=/i.test(argv[index])) {
      nodeOptions.push(removeDatadogNodeOptions(argv[index].slice(argv[index].indexOf('=') + 1)))
      continue
    }
    sanitized.push(argv[index])
  }
  return { argv: sanitized, nodeOptions }
}

/**
 * Removes shell NODE_OPTIONS assignments while retaining their non-Datadog values.
 *
 * @param {string} source shell command
 * @returns {{command: string, nodeOptions: string[]}} rewritten command and preserved options
 */
function removeInlineShellNodeOptions (source) {
  const nodeOptions = []
  const command = String(source || '').replaceAll(
    /(\bexport\s+)?NODE_OPTIONS\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]+)(?:\s*;)?/gi,
    (assignment, _export, value) => {
      nodeOptions.push(removeDatadogNodeOptions(unquote(value)))
      return ''
    }
  )
  return { command, nodeOptions }
}

/**
 * Removes dd-trace initialization flags while retaining options required by the project runner.
 *
 * @param {string} value NODE_OPTIONS value
 * @returns {string} non-Datadog NODE_OPTIONS
 */
function removeDatadogNodeOptions (value) {
  const tokens = String(value || '').match(/"[^"]*"|'[^']*'|[^\s]+/g) || []
  const preserved = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const inline = /^(--require|--import|-r)=(.+)$/.exec(token)
    if (inline && isDatadogPreload(inline[2])) continue
    if (['--require', '--import', '-r'].includes(token) && isDatadogPreload(tokens[index + 1])) {
      index++
      continue
    }
    preserved.push(token)
  }
  return preserved.join(' ')
}

/**
 * Reports whether one Node.js preload initializes dd-trace.
 *
 * @param {string|undefined} value preload target
 * @returns {boolean} whether the preload belongs to dd-trace initialization
 */
function isDatadogPreload (value) {
  const preload = normalizePath(unquote(String(value || '')))
  return DATADOG_PRELOAD_PATHS.has(preload) || DATADOG_PRELOAD_PATTERN.test(preload)
}

/**
 * Removes one pair of shell-style quotes.
 *
 * @param {string} value quoted value
 * @returns {string} unquoted value
 */
function unquote (value) {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
}

/**
 * Normalizes a preload path for platform-independent comparison.
 *
 * @param {string} value preload path
 * @returns {string} normalized path
 */
function normalizePath (value) {
  return value.replaceAll('\\', '/')
}

function summarizeProbeResult ({ framework, result, records, recordsPath }) {
  const processRecords = records.filter(record => record.type === 'process-start')
  const moduleLoadRecords = records.filter(record => record.type === 'module-load')
  const testRunnerSignals = getToolSignals(records, 'test-runner')
    .filter(signal => signal.name === framework.framework)
  const wrapperSignals = getToolSignals(records, 'wrapper', { processStartsOnly: true })
  const packageManagerSignals = getToolSignals(records, 'package-manager', { processStartsOnly: true })

  return {
    ran: true,
    commandExitCode: result.exitCode,
    commandTimedOut: result.timedOut,
    processCount: processRecords.length,
    moduleLoadCount: moduleLoadRecords.length,
    reachedAnyNodeProcess: processRecords.length > 0,
    reachedTestRunnerProcess: testRunnerSignals.length > 0,
    stoppedAfterRunnerReached: result.stoppedEarly === true && testRunnerSignals.length > 0,
    testRunnerSignals,
    wrapperSignals,
    packageManagerSignals,
    recordsPath,
  }
}

function probeReachedFramework (recordsPath, frameworkName) {
  return readProbeRecords(recordsPath).some(record => {
    return getRecordTools(record).some(tool => tool.kind === 'test-runner' && tool.name === frameworkName)
  })
}

function getToolSignals (records, kind, { processStartsOnly = false } = {}) {
  const signals = []
  const signalsByLocation = new Map()

  for (const record of records) {
    if (processStartsOnly && record.type !== 'process-start') continue
    for (const tool of getRecordTools(record)) {
      if (tool.kind !== kind) continue

      const key = `${tool.name}:${record.cwd}`
      let signal = signalsByLocation.get(key)
      if (!signal) {
        signal = {
          name: tool.name,
          kind: tool.kind,
          pid: record.pid,
          ppid: record.ppid,
          source: record.type,
          argv: Array.isArray(record.argv) ? record.argv : undefined,
          cwd: record.cwd,
          request: record.request,
          processCount: 0,
          processIds: new Set(),
        }
        signalsByLocation.set(key, signal)
        signals.push(signal)
      }
      signal.processIds.add(record.pid)
    }
  }

  return signals.map(signal => {
    signal.processCount = signal.processIds.size
    delete signal.processIds
    return signal
  })
}

function getRecordTools (record) {
  if (record.tool) return [record.tool]
  if (Array.isArray(record.detectedTools)) return record.detectedTools
  return []
}

function readProbeRecords (recordsPath) {
  let file
  try {
    file = fs.openSync(recordsPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const stat = fs.fstatSync(file)
    if (!stat.isFile() || stat.size > MAX_PROBE_RECORD_BYTES) return []
    const content = fs.readFileSync(file, 'utf8')
    return parseProbeRecords(content)
  } catch {
    return []
  } finally {
    if (file !== undefined) fs.closeSync(file)
  }
}

function parseProbeRecords (content) {
  const records = []
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue
    try {
      const record = JSON.parse(line)
      if (isProbeRecord(record)) records.push(sanitizeForReport(record))
    } catch {}
  }
  return records
}

function isProbeRecord (record) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    (record.type === 'process-start' || record.type === 'module-load') &&
    Number.isInteger(record.pid) && Number.isInteger(record.ppid) &&
    typeof record.cwd === 'string' && Array.isArray(record.argv)
}

function formatNodeRequire (filename) {
  if (!/\s/.test(filename)) return filename
  return JSON.stringify(filename)
}

module.exports = {
  runInitializationProbe,
}

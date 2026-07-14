'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  mergeNodeOptions,
  runCommand,
} = require('./command-runner')
const { sanitizeForReport } = require('./redaction')
const { createFileSafely, ensureSafeDirectory, writeFileSafely } = require('./safe-files')

const PROBE_PRELOAD = path.join(__dirname, 'init-probe-preload.js')
const PROBE_FILE_ENV = 'DD_TEST_OPTIMIZATION_INIT_PROBE_FILE'
const MAX_PROBE_RECORD_BYTES = 1024 * 1024

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
  if (!command.env?.NODE_OPTIONS) return command

  const env = { ...command.env }
  const nodeOptions = removeDatadogPreloads(env.NODE_OPTIONS)
  if (nodeOptions) {
    env.NODE_OPTIONS = nodeOptions
  } else {
    delete env.NODE_OPTIONS
  }

  return {
    ...command,
    env,
  }
}

function removeDatadogPreloads (nodeOptions) {
  const tokens = tokenizeNodeOptions(nodeOptions)
  const kept = []

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (isSeparatedPreloadFlag(token) && isDatadogPreload(tokens[index + 1])) {
      index++
      continue
    }
    if (isInlineDatadogPreload(token)) continue
    kept.push(token)
  }

  return kept.join(' ')
}

function tokenizeNodeOptions (nodeOptions) {
  return String(nodeOptions || '').match(/"[^"]*"|'[^']*'|\S+/g) || []
}

function isSeparatedPreloadFlag (token) {
  return token === '-r' || token === '--require' || token === '--import'
}

function isInlineDatadogPreload (token) {
  return (token.startsWith('--require=') && isDatadogPreload(token.slice('--require='.length))) ||
    (token.startsWith('--import=') && isDatadogPreload(token.slice('--import='.length))) ||
    (token.startsWith('-r') && token.length > 2 && isDatadogPreload(token.slice(2)))
}

function isDatadogPreload (value) {
  const normalized = String(value || '').replaceAll(/^['"]|['"]$/g, '')
  return normalized.includes('dd-trace/ci/init') || normalized.includes('dd-trace/register')
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

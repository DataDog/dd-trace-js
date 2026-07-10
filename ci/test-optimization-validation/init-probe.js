'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  buildCiWiringEnv,
  mergeNodeOptions,
  runCommand,
} = require('./command-runner')
const { ensureSafeDirectory, writeFileSafely } = require('./safe-files')

const PROBE_PRELOAD = path.join(__dirname, 'init-probe-preload.js')
const PROBE_FILE_ENV = 'DD_TEST_OPTIMIZATION_INIT_PROBE_FILE'

/**
 * Runs a CI-shaped command with a lightweight NODE_OPTIONS preload that records process reachability.
 *
 * @param {object} options probe options
 * @param {object} options.command manifest command to run
 * @param {object} options.framework manifest framework entry
 * @param {object} options.intake fake intake used for local transport overrides
 * @param {string} options.outDir scenario output directory
 * @param {object} options.options CLI options
 * @returns {Promise<{ artifacts: object, summary: object }>} probe artifacts and summary
 */
async function runInitializationProbe ({ command, framework, intake, outDir, options }) {
  const probeOutDir = path.join(outDir, 'initialization-probe')
  const recordsPath = path.join(probeOutDir, 'records.ndjson')
  const probeCommand = getProbeCommand(command)

  ensureSafeDirectory(outDir, probeOutDir, 'initialization probe artifact directory')
  writeFileSafely(outDir, recordsPath, '', 'initialization probe records')

  const transportEnv = buildCiWiringEnv({ intake })
  const result = await runCommand(probeCommand, {
    artifactRoot: outDir,
    env: {
      ...transportEnv,
      [PROBE_FILE_ENV]: recordsPath,
      NODE_OPTIONS: mergeNodeOptions(
        transportEnv.NODE_OPTIONS,
        `-r ${formatNodeRequire(PROBE_PRELOAD)}`
      ),
    },
    envMode: 'clean',
    outDir: probeOutDir,
    label: `${framework.id}:ci-wiring:init-probe`,
    verbose: options.verbose,
  })
  const records = readProbeRecords(recordsPath)

  return {
    artifacts: {
      command: result.artifacts.command,
      records: recordsPath,
      stderr: result.artifacts.stderr,
      stdout: result.artifacts.stdout,
    },
    summary: summarizeProbeResult({ result, records, recordsPath }),
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

function summarizeProbeResult ({ result, records, recordsPath }) {
  const processRecords = records.filter(record => record.type === 'process-start')
  const moduleLoadRecords = records.filter(record => record.type === 'module-load')
  const testRunnerSignals = getToolSignals(records, 'test-runner')
  const wrapperSignals = getToolSignals(records, 'wrapper')
  const packageManagerSignals = getToolSignals(records, 'package-manager')

  return {
    ran: true,
    commandExitCode: result.exitCode,
    commandTimedOut: result.timedOut,
    processCount: processRecords.length,
    moduleLoadCount: moduleLoadRecords.length,
    reachedAnyNodeProcess: processRecords.length > 0,
    reachedTestRunnerProcess: testRunnerSignals.length > 0,
    testRunnerSignals,
    wrapperSignals,
    packageManagerSignals,
    recordsPath,
  }
}

function getToolSignals (records, kind) {
  const signals = []
  const seen = new Set()

  for (const record of records) {
    for (const tool of getRecordTools(record)) {
      if (tool.kind !== kind) continue

      const key = `${tool.name}:${record.pid}:${record.type}`
      if (seen.has(key)) continue
      seen.add(key)
      signals.push({
        name: tool.name,
        kind: tool.kind,
        pid: record.pid,
        ppid: record.ppid,
        source: record.type,
        argv: Array.isArray(record.argv) ? record.argv : undefined,
        cwd: record.cwd,
        request: record.request,
      })
    }
  }

  return signals
}

function getRecordTools (record) {
  if (record.tool) return [record.tool]
  if (Array.isArray(record.detectedTools)) return record.detectedTools
  return []
}

function readProbeRecords (recordsPath) {
  let content
  try {
    content = fs.readFileSync(recordsPath, 'utf8')
  } catch {
    return []
  }

  const records = []
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      records.push({
        type: 'parse-error',
        line,
      })
    }
  }
  return records
}

function formatNodeRequire (filename) {
  if (!/\s/.test(filename)) return filename
  return JSON.stringify(filename)
}

module.exports = {
  runInitializationProbe,
}

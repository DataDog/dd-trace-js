'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { parseBoundedJson } = require('./bounded-json')
const { normalizeRequests } = require('./payload-normalizer')

const MAX_COMPLETION_BYTES = 4096
const MAX_COMPLETION_FILES = 2048
const MAX_COMPLETION_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_DECODED_COLLECTION_ENTRIES = 100_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_FILES = 10_000
const MAX_OUTPUT_MODULES = 500
const MAX_OUTPUT_SUITES = 1000
const MAX_OUTPUT_TESTS = 2000
const MAX_OUTPUT_STRING_BYTES = 64 * 1024
const MAX_SAMPLED_EVENTS_PER_PROCESS = 11
const MAX_SAMPLED_COVERAGE_FILES_PER_PROCESS = 8
const INPUT_NAMES = new Set(['known_tests', 'settings', 'skippable_tests', 'test_management'])
const EVENT_TYPES = new Set(['test', 'test_module_end', 'test_session_end', 'test_suite_end'])
const META_FIELDS = new Set([
  'test.command',
  'test.early_flake.enabled',
  'test.final_status',
  'test.is_new',
  'test.is_retry',
  'test.module',
  'test.name',
  'test.retry_reason',
  'test.source.file',
  'test.status',
  'test.suite',
  'test.test_management.attempt_to_fix_passed',
  'test.test_management.enabled',
  'test.test_management.is_attempt_to_fix',
  'test.test_management.is_quarantined',
  'test.test_management.is_test_disabled',
])
const METRIC_FIELDS = new Set(['test.is_new', 'test.is_retry'])
const COVERAGE_FIELDS = new Set(['fileCount', 'test_session_id', 'test_suite_id'])
const ROOT_ENTRIES = new Set(['completions', 'payloads'])
const PAYLOAD_KINDS = new Set(['coverage', 'tests'])

/**
 * Reads bounded projected payloads and reconciles them with authoritative per-process completion records.
 *
 * @param {string} outputRoot payload output root
 * @returns {object} parsed output and aggregate capture metadata
 */
function readOfflineOutput (outputRoot) {
  assertDirectory(outputRoot, 'output root')
  assertDirectoryEntries(outputRoot, ROOT_ENTRIES)

  const payloadsRoot = path.join(outputRoot, 'payloads')
  const completionsRoot = path.join(outputRoot, 'completions')
  const exporterInitialized = exists(payloadsRoot) || exists(completionsRoot)
  if (!exporterInitialized) return emptyOutput()

  const state = {
    bytes: 0,
    completionBytes: 0,
    decodedEntries: 0,
    files: 0,
  }
  const completions = readCompletions(outputRoot, completionsRoot, state)
  const captureMode = getCaptureMode(completions)
  state.eventCounts = { modules: 0, suites: 0, tests: 0, total: 0 }
  const artifactsByProcess = new Map()
  const events = []
  const coverage = []

  if (exists(payloadsRoot)) {
    assertDirectory(payloadsRoot, 'payloads directory')
    assertPathInside(outputRoot, payloadsRoot)
    assertDirectoryEntries(payloadsRoot, PAYLOAD_KINDS)
    readPayloadFiles(payloadsRoot, 'tests', state, (processId, value) => {
      assertTestPayload(value)
      const normalized = normalizeRequests([{ url: '/api/v2/citestcycle', payload: value }])
      for (const event of normalized) {
        assertRecognizedEventBudget(event, captureMode, completions.length, state.eventCounts)
        events.push(event)
      }
      const artifact = getProcessArtifacts(artifactsByProcess, processId)
      artifact.payloadFiles++
      artifact.eventsRetained += normalized.length
    })
    readPayloadFiles(payloadsRoot, 'coverage', state, (processId, value) => {
      assertCoveragePayload(value)
      coverage.push(value)
      getProcessArtifacts(artifactsByProcess, processId).coverageFilesRetained++
    })
  }

  if (completions.length === 0) {
    throw new Error('Offline Test Optimization exporter initialized but did not write completion evidence.')
  }
  reconcileCompletions(completions, artifactsByProcess)

  const summary = aggregateCompletions(completions)
  return {
    captureMode,
    completionCount: completions.length,
    coverage,
    coverageFileCount: summary.coverageFilesRetained,
    events,
    initialized: true,
    inputs: summary.inputs,
    observedEventCount: summary.eventsObserved,
    payloadFileCount: summary.payloadFiles,
    retainedEventCount: summary.eventsRetained,
    sampled: summary.eventsObserved > summary.eventsRetained,
    summary,
  }
}

function readCompletions (outputRoot, directory, state) {
  if (!exists(directory)) return []
  assertDirectory(directory, 'completions directory')
  assertPathInside(outputRoot, directory)
  const filenames = fs.readdirSync(directory).sort()
  if (filenames.length > MAX_COMPLETION_FILES) {
    throw new Error(`Offline validation output exceeds ${MAX_COMPLETION_FILES} completion records.`)
  }

  const completions = []
  const processIds = new Set()
  for (const name of filenames) {
    const match = /^completion-([a-f0-9]{32})\.json$/.exec(name)
    if (!match) throw new Error('Offline validation completions directory contains an unexpected entry.')
    const buffer = readRegularFile(path.join(directory, name), MAX_COMPLETION_BYTES, state, true)
    const parsed = parseOutputJson(buffer, 'completion record', state, 1000)
    assertCompletion(parsed, match[1])
    if (processIds.has(parsed.processId)) throw new Error('Offline validation contains duplicate completion records.')
    processIds.add(parsed.processId)
    completions.push(parsed)
  }
  return completions
}

function readPayloadFiles (payloadsRoot, kind, state, consume) {
  const directory = path.join(payloadsRoot, kind)
  if (!exists(directory)) return
  assertDirectory(directory, `${kind} payload directory`)
  assertPathInside(payloadsRoot, directory)

  const pattern = new RegExp(String.raw`^${kind}-([a-f0-9]{32})-[0-9]+-[0-9]+-[0-9]+\.json$`)
  const filenames = fs.readdirSync(directory).sort()
  if (state.files + filenames.length > MAX_OUTPUT_FILES) {
    throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_FILES} payload files.`)
  }
  for (const name of filenames) {
    const match = pattern.exec(name)
    if (!match) throw new Error(`Offline validation ${kind} payload directory contains an unexpected entry.`)
    state.files++
    const buffer = readRegularFile(path.join(directory, name), MAX_OUTPUT_BYTES, state, false)
    consume(match[1], parseOutputJson(buffer, `${kind} payload`, state, MAX_DECODED_COLLECTION_ENTRIES))
  }
}

function readRegularFile (filename, individualLimit, state, completion) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error('Offline validation artifact must be a regular, unlinked file.')
  }
  if (stat.size > individualLimit) throw new Error(`Offline validation artifact exceeds ${individualLimit} bytes.`)
  const totalKey = completion ? 'completionBytes' : 'bytes'
  const totalLimit = completion ? MAX_COMPLETION_TOTAL_BYTES : MAX_OUTPUT_BYTES
  if (state[totalKey] + stat.size > totalLimit) {
    throw new Error(`Offline validation output exceeds ${totalLimit} aggregate bytes.`)
  }

  const file = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(file)
    if (!opened.isFile() || opened.nlink > 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('Offline validation artifact changed while it was opened.')
    }
    const buffer = fs.readFileSync(file)
    const completed = fs.fstatSync(file)
    if (completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs) {
      throw new Error('Offline validation artifact changed while it was read.')
    }
    state[totalKey] += buffer.length
    return buffer
  } finally {
    fs.closeSync(file)
  }
}

function parseOutputJson (buffer, label, state, perFileEntries) {
  if (buffer.length === 0) throw new Error(`Offline validation ${label} is empty.`)
  const parsed = parseBoundedJson(buffer, {
    label: `Offline validation ${label}`,
    maxCollectionEntries: perFileEntries,
    maxNestingDepth: 64,
    maxStringBytes: MAX_OUTPUT_STRING_BYTES,
  })
  state.decodedEntries += parsed.collectionEntries
  if (state.decodedEntries > MAX_DECODED_COLLECTION_ENTRIES) {
    throw new Error(
      `Offline validation output exceeds ${MAX_DECODED_COLLECTION_ENTRIES} aggregate decoded entries.`
    )
  }
  return parsed.value
}

function assertTestPayload (value) {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.events) ||
    Object.keys(value).sort().join(',') !== 'events,version') {
    throw new Error('Offline validation test payload has an unsupported JSON shape.')
  }
  for (const event of value.events) {
    if (!isObject(event) || !EVENT_TYPES.has(event.type) || !isObject(event.content) ||
      !isObject(event.content.meta) || !isObject(event.content.metrics) ||
      Object.keys(event).sort().join(',') !== 'content,type' ||
      Object.keys(event.content).sort().join(',') !== 'meta,metrics' ||
      Object.keys(event.content.meta).some(name => !META_FIELDS.has(name)) ||
      Object.keys(event.content.metrics).some(name => !METRIC_FIELDS.has(name))) {
      throw new Error('Offline validation test payload contains an unsupported event shape.')
    }
  }
}

function assertCoveragePayload (value) {
  if (!Array.isArray(value) || value.some(record => {
    if (!isObject(record) || Object.keys(record).some(name => !COVERAGE_FIELDS.has(name))) return true
    if (record.fileCount !== undefined && !isCount(record.fileCount)) return true
    return ['test_session_id', 'test_suite_id'].some(name => {
      const field = record[name]
      return field !== undefined && typeof field !== 'string' && typeof field !== 'number'
    })
  })) {
    throw new Error('Offline validation coverage payload has an unsupported JSON shape.')
  }
}

function assertCompletion (completion, filenameProcessId) {
  if (!isObject(completion) || Object.keys(completion).sort().join(',') !==
    'captureMode,counts,errors,inputs,processId,version' || completion.version !== 1 ||
    completion.processId !== filenameProcessId || !/^[a-f0-9]{32}$/.test(completion.processId) ||
    !['sample', 'strict'].includes(completion.captureMode) || !isObject(completion.counts) ||
    !isObject(completion.inputs) || !Array.isArray(completion.errors) || completion.errors.length > 20) {
    throw invalidCompletionError()
  }
  const countKeys = [
    'coverageFilesObserved',
    'coverageFilesRetained',
    'eventsObserved',
    'eventsRetained',
    'payloadFiles',
  ]
  if (Object.keys(completion.counts).sort().join(',') !== countKeys.sort().join(',') ||
    countKeys.some(name => !isCount(completion.counts[name])) ||
    completion.counts.coverageFilesRetained > completion.counts.coverageFilesObserved ||
    completion.counts.eventsRetained > completion.counts.eventsObserved ||
    completion.errors.some(error => typeof error !== 'string' || error.length > 100)) {
    throw invalidCompletionError()
  }
  assertCompletionInputs(completion.inputs)
  if (completion.captureMode === 'sample' &&
    (completion.counts.eventsRetained > MAX_SAMPLED_EVENTS_PER_PROCESS ||
      completion.counts.coverageFilesRetained > MAX_SAMPLED_COVERAGE_FILES_PER_PROCESS)) {
    throw invalidCompletionError()
  }
}

function getCaptureMode (completions) {
  if (completions.length === 0) return
  const captureMode = completions[0].captureMode
  if (completions.some(completion => completion.captureMode !== captureMode)) {
    throw new Error('Offline Test Optimization completion records use inconsistent capture modes.')
  }
  return captureMode
}

function assertCompletionInputs (inputs) {
  for (const [name, input] of Object.entries(inputs)) {
    if (!INPUT_NAMES.has(name) || !isObject(input) || Object.keys(input).join(',') !== 'status' ||
      !['error', 'loaded'].includes(input.status)) {
      throw invalidCompletionError()
    }
  }
}

function reconcileCompletions (completions, artifactsByProcess) {
  const completionsByProcess = new Map(completions.map(completion => [completion.processId, completion]))
  for (const processId of artifactsByProcess.keys()) {
    if (!completionsByProcess.has(processId)) {
      throw new Error('Offline validation payload artifacts do not have matching completion evidence.')
    }
  }
  for (const completion of completions) {
    const artifacts = artifactsByProcess.get(completion.processId) || emptyProcessArtifacts()
    const counts = completion.counts
    if (counts.payloadFiles !== artifacts.payloadFiles ||
      counts.coverageFilesRetained !== artifacts.coverageFilesRetained ||
      counts.eventsRetained !== artifacts.eventsRetained) {
      throw new Error('Offline Test Optimization completion evidence does not match retained payload artifacts.')
    }
  }
}

function aggregateCompletions (completions) {
  const aggregate = {
    coverageFilesObserved: 0,
    coverageFilesRetained: 0,
    errors: [],
    eventsObserved: 0,
    eventsRetained: 0,
    inputs: {},
    payloadFiles: 0,
  }
  for (const completion of completions) {
    for (const name of [
      'coverageFilesObserved',
      'coverageFilesRetained',
      'eventsObserved',
      'eventsRetained',
      'payloadFiles',
    ]) {
      aggregate[name] = addCount(aggregate[name], completion.counts[name])
    }
    for (const error of completion.errors) {
      if (!aggregate.errors.includes(error)) aggregate.errors.push(error)
    }
    mergeInputs(aggregate.inputs, completion.inputs)
  }
  return aggregate
}

function getProcessArtifacts (artifacts, processId) {
  let value = artifacts.get(processId)
  if (!value) {
    value = emptyProcessArtifacts()
    artifacts.set(processId, value)
  }
  return value
}

function emptyProcessArtifacts () {
  return { coverageFilesRetained: 0, eventsRetained: 0, payloadFiles: 0 }
}

function mergeInputs (aggregate, inputs) {
  for (const [name, input] of Object.entries(inputs)) {
    aggregate[name] = {
      status: aggregate[name]?.status === 'error' || input.status === 'error' ? 'error' : 'loaded',
    }
  }
}

function addCount (current, value) {
  const total = current + value
  if (!Number.isSafeInteger(total)) throw invalidCompletionError()
  return total
}

function isCount (value) {
  return Number.isSafeInteger(value) && value >= 0
}

function invalidCompletionError () {
  return new Error('Invalid offline Test Optimization exporter completion record.')
}

function assertDirectory (directory, label) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Offline validation ${label} must be a regular directory.`)
  }
}

function assertDirectoryEntries (directory, allowed) {
  if (fs.readdirSync(directory).some(entry => !allowed.has(entry))) {
    throw new Error('Offline validation payload output contains an unexpected entry.')
  }
}

function assertPathInside (parent, child) {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Offline validation payload path resolves outside its output root.')
  }
}

function exists (filename) {
  try {
    fs.lstatSync(filename)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function emptyOutput () {
  return {
    captureMode: undefined,
    completionCount: 0,
    coverage: [],
    coverageFileCount: 0,
    events: [],
    initialized: false,
    inputs: {},
    observedEventCount: 0,
    payloadFileCount: 0,
    retainedEventCount: 0,
    sampled: false,
    summary: undefined,
  }
}

function assertRecognizedEventBudget (event, captureMode, processCount, counts) {
  counts.total++
  if (captureMode === 'sample') {
    if (counts.total > processCount * MAX_SAMPLED_EVENTS_PER_PROCESS) {
      throw new Error('Offline validation sampled output exceeds its run-wide recognized-event budget.')
    }
    return
  }
  if (event.type === 'test_module_end' && ++counts.modules > MAX_OUTPUT_MODULES) {
    throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_MODULES} test modules.`)
  }
  if (event.type === 'test_suite_end' && ++counts.suites > MAX_OUTPUT_SUITES) {
    throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_SUITES} test suites.`)
  }
  if (event.type === 'test' && ++counts.tests > MAX_OUTPUT_TESTS) {
    throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_TESTS} tests.`)
  }
}

function isObject (value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

module.exports = {
  MAX_COMPLETION_FILES,
  MAX_DECODED_COLLECTION_ENTRIES,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_FILES,
  MAX_OUTPUT_MODULES,
  MAX_OUTPUT_SUITES,
  MAX_OUTPUT_TESTS,
  readOfflineOutput,
}

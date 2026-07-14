'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { decodeBodyWithMetadata } = require('./payload-decoder')
const { normalizeRequests } = require('./payload-normalizer')

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_FILES = 10_000
const MAX_OUTPUT_MODULES = 500
const MAX_OUTPUT_SUITES = 1000
const MAX_OUTPUT_TESTS = 2000
const MAX_OUTPUT_STRING_BYTES = 64 * 1024
const SUMMARY_PREFIX = 'DD_TEST_OPTIMIZATION_VALIDATION_V1 '
const INPUT_NAMES = new Set(['known_tests', 'settings', 'skippable_tests', 'test_management'])
const PAYLOAD_KINDS = new Set(['coverage', 'tests'])

/**
 * Reads and validates completed offline payload-file artifacts.
 *
 * @param {string} outputRoot payload output root
 * @returns {{
 *   coverage: object[],
 *   coverageFileCount: number,
 *   events: object[],
 *   inputs: object,
 *   payloadFileCount: number
 * }} parsed output
 */
function readOfflineOutput (outputRoot) {
  assertDirectory(outputRoot, 'output root')
  assertDirectoryEntries(outputRoot, new Set(['payloads']), true)

  const payloadsRoot = path.join(outputRoot, 'payloads')
  if (!exists(payloadsRoot)) return emptyOutput()
  assertDirectory(payloadsRoot, 'payloads directory')
  assertPathInside(outputRoot, payloadsRoot)
  assertDirectoryEntries(payloadsRoot, PAYLOAD_KINDS, true)

  const state = { bytes: 0, files: 0 }
  const testPayloads = readPayloadFiles(payloadsRoot, 'tests', state)
  const coveragePayloads = readPayloadFiles(payloadsRoot, 'coverage', state)
  const requests = []
  for (const payload of testPayloads) {
    const value = decodeJsonPayload(payload, 'test event')
    assertBoundedOutputValue(value)
    if (!isTestCyclePayload(value)) {
      throw new Error('Offline validation test payload has an unsupported JSON shape.')
    }
    requests.push({ url: '/api/v2/citestcycle', payload: value })
  }

  const coverage = []
  for (const payload of coveragePayloads) {
    const value = decodeJsonPayload(payload, 'coverage')
    assertBoundedOutputValue(value)
    coverage.push(value)
  }

  const events = normalizeRequests(requests)
  assertEventLimits(events)

  return {
    coverage,
    coverageFileCount: coveragePayloads.length,
    events,
    inputs: {},
    payloadFileCount: testPayloads.length,
  }
}

/**
 * Extracts and aggregates every bounded process-local exporter summary from command stderr.
 *
 * @param {string} stderr command standard error
 * @returns {object|undefined} parsed summary
 */
function parseOfflineSummary (stderr) {
  const lines = String(stderr || '').split(/\r?\n/)
  const aggregate = {
    coverageFiles: 0,
    errors: [],
    events: 0,
    input: 'filesystem-cache',
    inputs: {},
    payloadFiles: 0,
  }
  let summaries = 0

  for (const line of lines) {
    if (!line.startsWith(SUMMARY_PREFIX)) continue
    const source = line.slice(SUMMARY_PREFIX.length)
    if (Buffer.byteLength(source) > 4096) throw invalidSummaryError()

    let summary
    try {
      summary = JSON.parse(source)
    } catch {
      throw invalidSummaryError()
    }

    assertSummary(summary)
    aggregate.coverageFiles = addSummaryCount(aggregate.coverageFiles, summary.coverageFiles)
    aggregate.events = addSummaryCount(aggregate.events, summary.events)
    aggregate.payloadFiles = addSummaryCount(aggregate.payloadFiles, summary.payloadFiles)
    mergeSummaryInputs(aggregate.inputs, summary.inputs)
    for (const error of summary.errors) {
      aggregate.errors.push(error)
      if (aggregate.errors.length > 20) throw invalidSummaryError()
    }
    summaries++
  }

  return summaries > 0 ? aggregate : undefined
}

/**
 * Validates one process-local exporter summary.
 *
 * @param {object} summary parsed summary
 */
function assertSummary (summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw invalidSummaryError()
  const keys = Object.keys(summary).sort()
  if (keys.join(',') !== 'coverageFiles,errors,events,input,inputs,payloadFiles') throw invalidSummaryError()
  if (!isCount(summary.coverageFiles) || !isCount(summary.events) || !isCount(summary.payloadFiles) ||
    summary.input !== 'filesystem-cache' || !Array.isArray(summary.errors) || summary.errors.length > 20 ||
    summary.errors.some(error => typeof error !== 'string' || error.length > 100)) {
    throw invalidSummaryError()
  }
  assertSummaryInputs(summary.inputs)
}

/**
 * Validates bounded cache input statuses from one process summary.
 *
 * @param {object} inputs cache input statuses
 */
function assertSummaryInputs (inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw invalidSummaryError()
  for (const [name, input] of Object.entries(inputs)) {
    if (!INPUT_NAMES.has(name) || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).join(',') !== 'status' || !['error', 'loaded'].includes(input.status)) {
      throw invalidSummaryError()
    }
  }
}

/**
 * Merges process-local cache input statuses, preserving any error result.
 *
 * @param {object} aggregate aggregate input statuses
 * @param {object} inputs process-local input statuses
 */
function mergeSummaryInputs (aggregate, inputs) {
  for (const [name, input] of Object.entries(inputs)) {
    const status = aggregate[name]?.status === 'error' || input.status === 'error' ? 'error' : 'loaded'
    aggregate[name] = { status }
  }
}

/**
 * Adds one non-negative safe summary count.
 *
 * @param {number} current aggregate count
 * @param {number} value process-local count
 * @returns {number} aggregate count
 */
function addSummaryCount (current, value) {
  const total = current + value
  if (!Number.isSafeInteger(total)) throw invalidSummaryError()
  return total
}

/**
 * Checks whether a value is a non-negative safe count.
 *
 * @param {unknown} value candidate count
 * @returns {boolean} whether the value is valid
 */
function isCount (value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Creates the stable error used for malformed or over-limit process summaries.
 *
 * @returns {Error} invalid summary error
 */
function invalidSummaryError () {
  return new Error('Invalid offline Test Optimization exporter summary.')
}

/**
 * Reads every bounded payload file for one payload kind.
 *
 * @param {string} payloadsRoot payloads directory
 * @param {'tests'|'coverage'} kind payload kind
 * @param {{bytes: number, files: number}} state aggregate limits
 * @returns {Buffer[]} payload file bodies
 */
function readPayloadFiles (payloadsRoot, kind, state) {
  const directory = path.join(payloadsRoot, kind)
  if (!exists(directory)) return []
  assertDirectory(directory, `${kind} payload directory`)
  assertPathInside(payloadsRoot, directory)

  const pattern = new RegExp(String.raw`^${kind}-[0-9]+-[0-9]+-[0-9]+\.json$`)
  const filenames = fs.readdirSync(directory).sort()
  if (state.files + filenames.length > MAX_OUTPUT_FILES) {
    throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_FILES} payload files.`)
  }
  const payloads = []
  for (const name of filenames) {
    if (!pattern.test(name)) {
      throw new Error(`Offline validation ${kind} payload directory contains an unexpected entry.`)
    }
    state.files++
    const filename = path.join(directory, name)
    const payload = readPayloadFile(filename, state)
    payloads.push(payload)
  }
  return payloads
}

/**
 * Reads one regular, unlinked payload file while enforcing aggregate bytes.
 *
 * @param {string} filename payload filename
 * @param {{bytes: number, files: number}} state aggregate limits
 * @returns {Buffer} payload body
 */
function readPayloadFile (filename, state) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error('Offline validation payload must be a regular, unlinked file.')
  }
  if (state.bytes + stat.size > MAX_OUTPUT_BYTES) {
    throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_BYTES} bytes.`)
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  const file = fs.openSync(filename, flags)
  try {
    const openedStat = fs.fstatSync(file)
    if (!openedStat.isFile() || openedStat.nlink > 1 || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
      throw new Error('Offline validation payload changed while it was opened.')
    }
    const payload = fs.readFileSync(file)
    const completedStat = fs.fstatSync(file)
    if (completedStat.size !== openedStat.size || completedStat.mtimeMs !== openedStat.mtimeMs) {
      throw new Error('Offline validation payload changed while it was read.')
    }
    state.bytes += payload.length
    return payload
  } finally {
    fs.closeSync(file)
  }
}

/**
 * Decodes one bounded JSON payload file.
 *
 * @param {Buffer} payload payload body
 * @param {string} label payload label
 * @returns {unknown} decoded payload
 */
function decodeJsonPayload (payload, label) {
  if (payload.length === 0) throw new Error(`Offline validation ${label} payload is empty.`)
  return decodeBodyWithMetadata(payload, { 'content-type': 'application/json' }).value
}

/**
 * Checks the direct Test Optimization JSON envelope.
 *
 * @param {unknown} value decoded payload
 * @returns {boolean} whether the payload has the expected envelope
 */
function isTestCyclePayload (value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 &&
    value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) &&
    Array.isArray(value.events))
}

/**
 * Validates an existing non-symbolic directory.
 *
 * @param {string} directory directory path
 * @param {string} label directory label
 */
function assertDirectory (directory, label) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Offline validation ${label} must be a regular directory.`)
  }
}

/**
 * Refuses unknown entries in one validator-owned directory.
 *
 * @param {string} directory directory path
 * @param {Set<string>} allowed allowed entry names
 * @param {boolean} allowMissing whether an empty directory is valid
 */
function assertDirectoryEntries (directory, allowed, allowMissing) {
  const entries = fs.readdirSync(directory)
  if (!allowMissing && entries.length === 0) throw new Error('Offline validation payload directory is empty.')
  if (entries.some(entry => !allowed.has(entry))) {
    throw new Error('Offline validation payload output contains an unexpected entry.')
  }
}

/**
 * Ensures a child resolves physically beneath its expected parent.
 *
 * @param {string} parent expected parent
 * @param {string} child child path
 */
function assertPathInside (parent, child) {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Offline validation payload path resolves outside its output root.')
  }
}

/**
 * Checks whether one path exists without following it.
 *
 * @param {string} filename candidate path
 * @returns {boolean} whether the path exists
 */
function exists (filename) {
  try {
    fs.lstatSync(filename)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Creates an empty parsed output.
 *
 * @returns {{
 *   coverage: object[], coverageFileCount: number, events: object[], inputs: object, payloadFileCount: number
 * }} empty output
 */
function emptyOutput () {
  return {
    coverage: [],
    coverageFileCount: 0,
    events: [],
    inputs: {},
    payloadFileCount: 0,
  }
}

/**
 * Enforces bounded module, suite, and test event counts.
 *
 * @param {object[]} events normalized events
 */
function assertEventLimits (events) {
  let modules = 0
  let suites = 0
  let tests = 0

  for (const event of events) {
    if (event.type === 'test_module_end' && ++modules > MAX_OUTPUT_MODULES) {
      throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_MODULES} test modules.`)
    }
    if (event.type === 'test_suite_end' && ++suites > MAX_OUTPUT_SUITES) {
      throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_SUITES} test suites.`)
    }
    if (event.type === 'test' && ++tests > MAX_OUTPUT_TESTS) {
      throw new Error(`Offline validation output exceeds ${MAX_OUTPUT_TESTS} tests.`)
    }
  }
}

/**
 * Enforces bounded strings throughout one decoded auxiliary payload.
 *
 * @param {unknown} value decoded value
 */
function assertBoundedOutputValue (value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string' && Buffer.byteLength(current) > MAX_OUTPUT_STRING_BYTES) {
      throw new Error('Offline validation output contains an oversized string.')
    }
    if (!current || typeof current !== 'object') continue
    for (const nestedValue of Object.values(current)) pending.push(nestedValue)
  }
}

module.exports = {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_FILES,
  MAX_OUTPUT_MODULES,
  MAX_OUTPUT_SUITES,
  MAX_OUTPUT_TESTS,
  parseOfflineSummary,
  readOfflineOutput,
}

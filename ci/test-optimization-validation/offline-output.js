'use strict'

const fs = require('node:fs')

const { decodeBodyWithMetadata, decodeMsgpack } = require('./payload-decoder')
const { normalizeRequests } = require('./payload-normalizer')

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_RECORDS = 10_000
const MAX_OUTPUT_MODULES = 500
const MAX_OUTPUT_SUITES = 1000
const MAX_OUTPUT_TESTS = 2000
const MAX_OUTPUT_STRING_BYTES = 64 * 1024
const SUMMARY_PREFIX = 'DD_TEST_OPTIMIZATION_VALIDATION_V1 '

/**
 * Reads and validates a completed offline exporter artifact.
 *
 * @param {string} filename event artifact path
 * @returns {{coverage: object[], events: object[], inputs: object, recordCount: number}}
 */
function readOfflineOutput (filename) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error('Offline validation event artifact must be a regular, unlinked file.')
  }
  if (stat.size > MAX_OUTPUT_BYTES) {
    throw new Error(`Offline validation event artifact exceeds ${MAX_OUTPUT_BYTES} bytes.`)
  }

  const content = fs.readFileSync(filename, 'utf8')
  const lines = content ? content.trimEnd().split('\n') : []
  if (lines.length > MAX_OUTPUT_RECORDS) {
    throw new Error(`Offline validation event artifact exceeds ${MAX_OUTPUT_RECORDS} records.`)
  }

  const requests = []
  const coverage = []
  const inputs = {}
  for (const line of lines) {
    const record = parseRecord(line)
    if (record.kind === 'test_cycle') {
      const bytes = Buffer.from(record.payload, 'base64')
      if (bytes.length > MAX_OUTPUT_BYTES) throw new Error('Offline validation encoded payload is too large.')
      requests.push({
        url: '/api/v2/citestcycle',
        payload: decodeMsgpack(bytes),
      })
    } else if (record.kind === 'coverage') {
      coverage.push(record.payload)
    } else if (record.kind === 'input') {
      const { error, name, status } = record.payload
      if (!/^(?:settings|known_tests|skippable_tests|test_management)$/.test(name) ||
        !/^(?:loaded|error)$/.test(status)) {
        throw new Error('Offline validation input record is malformed.')
      }
      inputs[name] = { error, status }
    }
  }

  const events = normalizeRequests(requests)
  assertEventLimits(events)

  return {
    coverage,
    events,
    inputs,
    recordCount: lines.length,
  }
}

/**
 * Extracts the last valid bounded exporter summary from command stderr.
 *
 * @param {string} stderr command standard error
 * @returns {object|undefined} parsed summary
 */
function parseOfflineSummary (stderr) {
  const lines = String(stderr || '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].startsWith(SUMMARY_PREFIX)) continue
    const source = lines[index].slice(SUMMARY_PREFIX.length)
    if (Buffer.byteLength(source) > 4096) return
    try {
      const summary = JSON.parse(source)
      if (!Number.isSafeInteger(summary.events) || summary.events < 0 ||
        !Number.isSafeInteger(summary.records) || summary.records < 0 ||
        summary.input !== 'filesystem-cache' || !Array.isArray(summary.errors) || summary.errors.length > 20 ||
        summary.errors.some(error => typeof error !== 'string' || error.length > 100)) {
        return
      }
      return summary
    } catch {
      return
    }
  }
}

function parseRecord (line) {
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
    throw new Error('Offline validation event record is too large.')
  }
  const record = decodeBodyWithMetadata(
    Buffer.from(line),
    { 'content-type': 'application/json' }
  ).value
  if (!record || record.version !== 1 ||
    !['coverage', 'input', 'test_cycle'].includes(record.kind)) {
    throw new Error('Offline validation event record has an unsupported envelope.')
  }
  if (record.kind === 'test_cycle' &&
    (record.encoding !== 'msgpack-base64' || typeof record.payload !== 'string')) {
    throw new Error('Offline validation test-cycle record is malformed.')
  }
  if (record.kind === 'input' && (!record.payload || typeof record.payload !== 'object')) {
    throw new Error('Offline validation input record is malformed.')
  }
  if (record.kind !== 'test_cycle') assertBoundedOutputValue(record.payload)
  return record
}

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
  MAX_OUTPUT_MODULES,
  MAX_OUTPUT_RECORDS,
  MAX_OUTPUT_SUITES,
  MAX_OUTPUT_TESTS,
  parseOfflineSummary,
  readOfflineOutput,
}

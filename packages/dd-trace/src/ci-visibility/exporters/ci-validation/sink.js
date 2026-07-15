'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { MAX_OUTPUT_BYTES, msgpackToJson } = require('./msgpack-to-json')
const { projectCoveragePayload, projectTestCyclePayload } = require('./payload-projection')

const MAX_OUTPUT_FILES = 10_000
const MAX_SAMPLED_COVERAGE_FILES = 8
const MAX_SAMPLED_TESTS = 8
const MAX_SUMMARY_ERRORS = 20
const SUMMARY_PREFIX = 'DD_TEST_OPTIMIZATION_VALIDATION_V1 '

let payloadFileSequence = 0

class CiValidationSink {
  #bytesWritten = 0
  #captureMode
  #completionDirectory
  #coverageDirectory
  #coverageFilesObserved = 0
  #coverageFilesRetained = 0
  #errors = []
  #eventsObserved = 0
  #eventsRetained = 0
  #fileCount = 0
  #inputs = Object.create(null)
  #outputRoot
  #outputRootDirectory
  #payloadsDirectory
  #processId = crypto.randomBytes(16).toString('hex')
  #sampledLifecycle = new Map()
  #sampledTests = []
  #summaryWritten = false
  #testsDirectory
  #testsObserved = 0
  #testPayloadFileCount = 0

  /**
   * Creates a bounded payload-file sink under a validator-owned output root.
   *
   * @param {string} outputRoot absolute validator-owned output directory
   * @param {object} [options] sink options
   * @param {'sample'|'strict'} [options.captureMode] evidence retention mode
   */
  constructor (outputRoot, { captureMode = 'strict' } = {}) {
    if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) {
      throw new Error('Offline Test Optimization validation output root must be absolute.')
    }

    if (!['sample', 'strict'].includes(captureMode)) {
      throw new Error('Offline Test Optimization validation capture mode is invalid.')
    }
    this.#captureMode = captureMode
    this.#outputRoot = outputRoot
    this.#outputRootDirectory = captureDirectory(outputRoot, 'output root')
    const payloadsRoot = path.join(outputRoot, 'payloads')
    this.#payloadsDirectory = createDirectory(outputRoot, this.#outputRootDirectory, payloadsRoot, 'payloads')
    this.#testsDirectory = createDirectory(
      payloadsRoot,
      this.#payloadsDirectory,
      path.join(payloadsRoot, 'tests'),
      'tests'
    )
    this.#coverageDirectory = createDirectory(
      payloadsRoot,
      this.#payloadsDirectory,
      path.join(payloadsRoot, 'coverage'),
      'coverage'
    )
    this.#completionDirectory = createDirectory(
      outputRoot,
      this.#outputRootDirectory,
      path.join(outputRoot, 'completions'),
      'completions'
    )
  }

  /**
   * Converts and writes one Test Optimization payload using the Bazel-compatible JSON layout.
   *
   * @param {Buffer} payload encoded Test Optimization payload
   */
  writeTestCycle (payload) {
    let decoded
    try {
      decoded = JSON.parse(msgpackToJson(payload).toString('utf8'))
    } catch {
      this.#fail('output_payload_decode_failed')
      return
    }

    let projected
    try {
      projected = projectTestCyclePayload(decoded)
    } catch {
      this.#fail('output_payload_projection_failed')
      return
    }

    this.#eventsObserved += projected.events.length
    if (this.#captureMode === 'sample') {
      this.#retainSample(projected.events)
      return
    }

    const json = Buffer.from(JSON.stringify(projected))
    if (this.#writePayloadFile('tests', json)) {
      this.#eventsRetained += projected.events.length
      this.#testPayloadFileCount++
    }
  }

  /**
   * Writes one coverage payload in the corresponding payload-file directory.
   *
   * @param {object|object[]} payload formatted coverage payload
   */
  writeCoverage (payload) {
    let json
    try {
      const serialized = JSON.stringify(projectCoveragePayload(payload))
      if (serialized === undefined) throw new Error('Coverage payload is not serializable.')
      json = Buffer.from(serialized)
    } catch {
      this.#fail('output_record_serialization_failed')
      return
    }

    this.#coverageFilesObserved++
    if (this.#captureMode === 'sample' && this.#coverageFilesRetained >= MAX_SAMPLED_COVERAGE_FILES) return
    if (this.#writePayloadFile('coverage', json)) {
      this.#coverageFilesRetained++
    }
  }

  /**
   * Records whether a control-plane fixture was loaded from the filesystem cache.
   *
   * @param {string} name fixed fixture name
   * @param {Error|undefined|null} error cache-load error
   */
  writeInputResult (name, error) {
    if (error) this.#addError(`invalid_${name}`)
    this.#inputs[name] = { status: error ? 'error' : 'loaded' }
  }

  /**
   * Records an exporter failure in the bounded validation summary.
   *
   * @param {string} code stable failure code
   */
  recordError (code) {
    this.#fail(code)
  }

  /**
   * Emits this process's single bounded stderr summary for validator aggregation.
   */
  writeSummary () {
    if (this.#summaryWritten) return
    this.#summaryWritten = true
    if (this.#captureMode === 'sample') this.#writeSampledEvents()
    const summary = {
      coverageFiles: this.#coverageFilesRetained,
      events: this.#eventsRetained,
      payloadFiles: this.#testPayloadFileCount,
      input: 'filesystem-cache',
      inputs: this.#inputs,
      errors: this.#errors,
    }
    if (!this.#writeCompletionRecord()) this.#fail('completion_write_failed')
    process.stderr.write(`${SUMMARY_PREFIX}${JSON.stringify(summary)}\n`)
  }

  /**
   * Retains bounded first/late test evidence and the latest lifecycle event of each type.
   *
   * @param {object[]} events projected events
   */
  #retainSample (events) {
    for (const event of events) {
      if (event.type !== 'test') {
        this.#sampledLifecycle.set(event.type, event)
        continue
      }
      this.#testsObserved++
      if (this.#sampledTests.length < MAX_SAMPLED_TESTS) {
        this.#sampledTests.push(event)
      } else {
        const lateIndex = Math.floor(MAX_SAMPLED_TESTS / 2) +
          (this.#testsObserved % Math.ceil(MAX_SAMPLED_TESTS / 2))
        this.#sampledTests[lateIndex] = event
      }
    }
  }

  /**
   * Persists the final bounded CI-replay sample after all process-local events have been observed.
   */
  #writeSampledEvents () {
    const events = [...this.#sampledTests, ...this.#sampledLifecycle.values()]
    if (events.length === 0) return
    const payload = Buffer.from(JSON.stringify({ version: 1, events }))
    if (this.#writePayloadFile('tests', payload)) {
      this.#eventsRetained = events.length
      this.#testPayloadFileCount++
    }
  }

  /**
   * Atomically publishes this process's bounded completion evidence.
   *
   * @returns {boolean} whether the record was published
   */
  #writeCompletionRecord () {
    const directoryPath = path.join(this.#outputRoot, 'completions')
    const filename = path.join(directoryPath, `completion-${this.#processId}.json`)
    const temporary = `${filename}.tmp`
    const completion = Buffer.from(JSON.stringify({
      version: 1,
      processId: this.#processId,
      captureMode: this.#captureMode,
      counts: {
        coverageFilesObserved: this.#coverageFilesObserved,
        coverageFilesRetained: this.#coverageFilesRetained,
        eventsObserved: this.#eventsObserved,
        eventsRetained: this.#eventsRetained,
        payloadFiles: this.#testPayloadFileCount,
      },
      inputs: this.#inputs,
      errors: this.#errors,
    }))

    try {
      assertDirectoryUnchanged(this.#outputRoot, this.#outputRootDirectory, 'output root')
      assertDirectoryUnchanged(directoryPath, this.#completionDirectory, 'completions')
      writeNewFile(temporary, completion)
      assertDirectoryUnchanged(directoryPath, this.#completionDirectory, 'completions')
      fs.renameSync(temporary, filename)
      return true
    } catch {
      removePartialFile(temporary, directoryPath, this.#completionDirectory)
      return false
    }
  }

  /**
   * Writes one completed JSON payload to a unique file.
   *
   * @param {'tests'|'coverage'} kind payload kind
   * @param {Buffer} payload JSON payload
   * @returns {boolean} whether the payload was written
   */
  #writePayloadFile (kind, payload) {
    if (this.#fileCount >= MAX_OUTPUT_FILES) {
      this.#fail('output_file_limit_exceeded')
      return false
    }
    if (this.#bytesWritten + payload.length > MAX_OUTPUT_BYTES) {
      this.#fail('output_byte_limit_exceeded')
      return false
    }

    const directory = kind === 'tests' ? this.#testsDirectory : this.#coverageDirectory
    const directoryPath = path.join(this.#outputRoot, 'payloads', kind)
    const sequence = ++payloadFileSequence
    const timestamp = BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n
    const filename = path.join(
      directoryPath,
      `${kind}-${this.#processId}-${timestamp}-${process.pid}-${sequence}.json`
    )
    let writeFailed = false
    try {
      assertDirectoryUnchanged(this.#outputRoot, this.#outputRootDirectory, 'output root')
      assertDirectoryUnchanged(path.join(this.#outputRoot, 'payloads'), this.#payloadsDirectory, 'payloads')
      assertDirectoryUnchanged(directoryPath, directory, kind)
      writeNewFile(filename, payload)
    } catch {
      writeFailed = true
    }
    if (writeFailed) {
      this.#fail('output_write_failed')
      removePartialFile(filename, directoryPath, directory)
      return false
    }

    this.#bytesWritten += payload.length
    this.#fileCount++
    return true
  }

  /**
   * Records a sink failure and makes the process unsuccessful.
   *
   * @param {string} code stable failure code
   */
  #fail (code) {
    this.#addError(code)
    process.exitCode = 1
  }

  /**
   * Adds one unique bounded summary error.
   *
   * @param {string} code stable failure code
   */
  #addError (code) {
    if (this.#errors.length >= MAX_SUMMARY_ERRORS || this.#errors.includes(code)) return
    this.#errors.push(code)
  }
}

/**
 * Writes one new private regular file and rejects hard links or non-files.
 *
 * @param {string} filename output filename
 * @param {Buffer} payload output bytes
 */
function writeNewFile (filename, payload) {
  const flags = fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0)
  const file = fs.openSync(filename, flags, 0o600)
  try {
    const stat = fs.fstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Offline Test Optimization output is not a private regular file.')
    }
    fs.writeFileSync(file, payload)
  } finally {
    fs.closeSync(file)
  }
}

/**
 * Captures the identity of one existing non-symbolic directory.
 *
 * @param {string} directory directory path
 * @param {string} label directory label
 * @returns {{dev: number, ino: number}} stable directory identity
 */
function captureDirectory (directory, label) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Offline Test Optimization validation ${label} must be a regular directory.`)
  }
  return { dev: stat.dev, ino: stat.ino }
}

/**
 * Creates or validates one child directory without accepting symbolic links.
 *
 * @param {string} parent parent directory path
 * @param {{dev: number, ino: number}} parentIdentity expected parent identity
 * @param {string} directory child directory path
 * @param {string} label directory label
 * @returns {{dev: number, ino: number}} stable child identity
 */
function createDirectory (parent, parentIdentity, directory, label) {
  assertDirectoryUnchanged(parent, parentIdentity, 'parent output')
  try {
    fs.mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return captureDirectory(directory, `${label} output directory`)
}

/**
 * Rejects a directory that changed after sink construction.
 *
 * @param {string} directory directory path
 * @param {{dev: number, ino: number}} identity expected directory identity
 * @param {string} label directory label
 */
function assertDirectoryUnchanged (directory, identity, label) {
  const current = captureDirectory(directory, label)
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`Offline Test Optimization validation ${label} changed during execution.`)
  }
}

/**
 * Removes a partially written final path without following symbolic links.
 *
 * @param {string} filename partial payload path
 * @param {string} directory expected parent directory
 * @param {{dev: number, ino: number}} identity expected parent identity
 */
function removePartialFile (filename, directory, identity) {
  try {
    assertDirectoryUnchanged(directory, identity, 'partial-file parent')
    const stat = fs.lstatSync(filename)
    if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(filename)
  } catch {}
}

module.exports = {
  CiValidationSink,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_FILES,
  SUMMARY_PREFIX,
}

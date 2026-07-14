'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { MAX_OUTPUT_BYTES, msgpackToJson } = require('./msgpack-to-json')

const MAX_OUTPUT_FILES = 10_000
const MAX_SUMMARY_ERRORS = 20
const SUMMARY_PREFIX = 'DD_TEST_OPTIMIZATION_VALIDATION_V1 '

let payloadFileSequence = 0

class CiValidationSink {
  #bytesWritten = 0
  #coverageDirectory
  #coverageFileCount = 0
  #errors = []
  #eventCount = 0
  #fileCount = 0
  #inputs = Object.create(null)
  #outputRoot
  #outputRootDirectory
  #payloadsDirectory
  #summaryWritten = false
  #testsDirectory
  #testPayloadFileCount = 0

  /**
   * Creates a bounded payload-file sink under a validator-owned output root.
   *
   * @param {string} outputRoot absolute validator-owned output directory
   */
  constructor (outputRoot) {
    if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) {
      throw new Error('Offline Test Optimization validation output root must be absolute.')
    }

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
  }

  /**
   * Converts and writes one Test Optimization payload using the Bazel-compatible JSON layout.
   *
   * @param {Buffer} payload encoded Test Optimization payload
   * @param {number} eventCount number of events represented by the payload
   */
  writeTestCycle (payload, eventCount) {
    let json
    try {
      json = msgpackToJson(payload)
    } catch {
      this.#fail('output_payload_conversion_failed')
      return
    }

    if (this.#writePayloadFile('tests', json)) {
      this.#eventCount += eventCount
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
      const serialized = JSON.stringify(payload)
      if (serialized === undefined) throw new Error('Coverage payload is not serializable.')
      json = Buffer.from(serialized)
    } catch {
      this.#fail('output_record_serialization_failed')
      return
    }

    if (this.#writePayloadFile('coverage', json)) this.#coverageFileCount++
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
   * Emits this process's single bounded stderr summary for validator aggregation.
   */
  writeSummary () {
    if (this.#summaryWritten) return
    this.#summaryWritten = true
    const summary = {
      coverageFiles: this.#coverageFileCount,
      events: this.#eventCount,
      payloadFiles: this.#testPayloadFileCount,
      input: 'filesystem-cache',
      inputs: this.#inputs,
      errors: this.#errors,
    }
    process.stderr.write(`${SUMMARY_PREFIX}${JSON.stringify(summary)}\n`)
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
    const filename = path.join(directoryPath, `${kind}-${timestamp}-${process.pid}-${sequence}.json`)
    let file
    let writeFailed = false
    try {
      assertDirectoryUnchanged(this.#outputRoot, this.#outputRootDirectory, 'output root')
      assertDirectoryUnchanged(path.join(this.#outputRoot, 'payloads'), this.#payloadsDirectory, 'payloads')
      assertDirectoryUnchanged(directoryPath, directory, kind)
      const flags = fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0)
      file = fs.openSync(filename, flags, 0o600)
      const stat = fs.fstatSync(file)
      if (!stat.isFile() || stat.nlink > 1) {
        throw new Error('Offline Test Optimization payload output is not a regular, unlinked file.')
      }
      fs.writeFileSync(file, payload)
    } catch {
      writeFailed = true
    } finally {
      if (file !== undefined) fs.closeSync(file)
    }
    if (writeFailed) {
      this.#fail('output_write_failed')
      removePartialFile(filename)
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
 */
function removePartialFile (filename) {
  try {
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

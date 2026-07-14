'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_RECORDS = 10_000
const MAX_SUMMARY_ERRORS = 20
const SUMMARY_PREFIX = 'DD_TEST_OPTIMIZATION_VALIDATION_V1 '

class CiValidationSink {
  #bytesWritten = 0
  #errors = []
  #eventCount = 0
  #file
  #recordCount = 0
  #summaryWritten = false

  /**
   * Creates a bounded append-only sink for offline validation records.
   *
  * @param {string} outputFile absolute validator-owned output file
  */
  constructor (outputFile) {
    if (typeof outputFile !== 'string' || !path.isAbsolute(outputFile)) {
      throw new Error('Offline Test Optimization validation output path must be absolute.')
    }

    const stat = fs.lstatSync(outputFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      throw new Error('Offline Test Optimization validation output must be a regular, unlinked file.')
    }
    if (stat.size > MAX_OUTPUT_BYTES) {
      throw new Error('Offline Test Optimization validation output already exceeds its size limit.')
    }

    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0)
    this.#file = fs.openSync(outputFile, flags)
    const openedStat = fs.fstatSync(this.#file)
    if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
      fs.closeSync(this.#file)
      this.#file = undefined
      throw new Error('Offline Test Optimization validation output changed while it was opened.')
    }
    this.#bytesWritten = stat.size
  }

  /**
   * Writes one encoded Test Optimization payload.
   *
   * @param {Buffer} payload encoded CI Visibility payload
   * @param {number} eventCount number of events represented by the payload
   */
  writeTestCycle (payload, eventCount) {
    this.#eventCount += eventCount
    this.#writeRecord({
      version: 1,
      kind: 'test_cycle',
      encoding: 'msgpack-base64',
      payload: payload.toString('base64'),
    })
  }

  /**
   * Writes one coverage payload without enabling coverage-report upload.
   *
   * @param {object|object[]} payload formatted coverage payload
   */
  writeCoverage (payload) {
    this.#writeRecord({ version: 1, kind: 'coverage', payload })
  }

  /**
   * Records whether a control-plane fixture was loaded from the filesystem cache.
   *
   * @param {string} name fixed fixture name
   * @param {Error|undefined|null} error cache-load error
   */
  writeInputResult (name, error) {
    if (error) this.#addError(`invalid_${name}`)
    this.#writeRecord({
      version: 1,
      kind: 'input',
      payload: {
        name,
        status: error ? 'error' : 'loaded',
        error: error ? boundedErrorMessage(error) : undefined,
      },
    })
  }

  /**
   * Emits the single bounded stderr summary consumed by the validator.
   */
  writeSummary () {
    if (this.#summaryWritten) return
    this.#summaryWritten = true
    const summary = {
      events: this.#eventCount,
      records: this.#recordCount,
      input: 'filesystem-cache',
      errors: this.#errors,
    }
    process.stderr.write(`${SUMMARY_PREFIX}${JSON.stringify(summary)}\n`)
    if (this.#file !== undefined) {
      fs.closeSync(this.#file)
      this.#file = undefined
    }
  }

  /**
   * Appends one bounded versioned record.
   *
   * @param {object} record output record
   * @returns {void}
   */
  #writeRecord (record) {
    if (this.#file === undefined) return
    if (this.#recordCount >= MAX_OUTPUT_RECORDS) {
      this.#fail('output_record_limit_exceeded')
      return
    }

    let line
    try {
      line = `${JSON.stringify(record)}\n`
    } catch {
      this.#fail('output_record_serialization_failed')
      return
    }
    const bytes = Buffer.byteLength(line)
    if (this.#bytesWritten + bytes > MAX_OUTPUT_BYTES) {
      this.#fail('output_byte_limit_exceeded')
      return
    }

    try {
      fs.writeSync(this.#file, line)
      this.#bytesWritten += bytes
      this.#recordCount++
    } catch {
      this.#fail('output_write_failed')
    }
  }

  /**
   * Records a sink failure and makes the process unsuccessful.
   *
   * @param {string} code stable failure code
   * @returns {void}
   */
  #fail (code) {
    this.#addError(code)
    process.exitCode = 1
  }

  /**
   * Adds one unique bounded summary error.
   *
   * @param {string} code stable failure code
   * @returns {void}
   */
  #addError (code) {
    if (this.#errors.length >= MAX_SUMMARY_ERRORS || this.#errors.includes(code)) return
    this.#errors.push(code)
  }
}

/**
 * Formats a bounded single-line cache error for the output artifact.
 *
 * @param {Error} error cache error
 * @returns {string} bounded error message
 */
function boundedErrorMessage (error) {
  const message = error?.message || String(error)
  let bounded = ''
  for (const character of message.slice(0, 1024)) {
    const code = character.charCodeAt(0)
    bounded += code < 0x20 || code === 0x7F ? ' ' : character
  }
  return bounded
}

module.exports = {
  CiValidationSink,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_RECORDS,
  SUMMARY_PREFIX,
}

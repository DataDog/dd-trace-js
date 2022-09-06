'use strict'
const { AgentEncoder } = require('./0.4')
const Chunk = require('./chunk')
const log = require('../log')

const FormData = require('../exporters/common/form-data')

const COVERAGE_PAYLOAD_VERSION = 1
const COVERAGE_KEYS_LENGTH = 4
const MAXIMUM_NUM_COVERAGE_FILES = 100

class CoverageCIVisibilityEncoder extends AgentEncoder {
  constructor () {
    super(...arguments)
    this.codeCoverageBuffers = []
    this._coverageBytes = new Chunk()
    this.form = new FormData()
    this.fileIndex = 1
    this.reset()
  }

  count () {
    return this.fileIndex - 1
  }

  encode (coverage) {
    const bytes = this._coverageBytes
    const coverageBuffer = this.encodeCodeCoverage(bytes, coverage)
    const coverageFilename = `coverage${this.fileIndex++}`

    this.form.append(
      coverageFilename,
      coverageBuffer,
      {
        filename: `${coverageFilename}.msgpack`,
        contentType: 'application/msgpack'
      }
    )

    if (this.fileIndex === MAXIMUM_NUM_COVERAGE_FILES) {
      log.debug('Coverage buffer reached the limit, flushing')
      this._writer.flush()
    }

    this.reset()
  }

  encodeCodeCoverage (bytes, coverage) {
    this._encodeMapPrefix(bytes, COVERAGE_KEYS_LENGTH)
    this._encodeString(bytes, 'version')
    this._encodeInteger(bytes, COVERAGE_PAYLOAD_VERSION)
    this._encodeString(bytes, 'trace_id')
    this._encodeId(bytes, coverage.traceId)
    this._encodeString(bytes, 'span_id')
    this._encodeId(bytes, coverage.spanId)
    this._encodeString(bytes, 'files')
    this._encodeArrayPrefix(bytes, coverage.files)
    for (const filename of coverage.files) {
      this._encodeMapPrefix(bytes, 1)
      this._encodeString(bytes, 'filename')
      this._encodeString(bytes, filename)
    }
    const traceSize = bytes.length
    const buffer = Buffer.allocUnsafe(traceSize)

    bytes.buffer.copy(buffer, 0, 0, bytes.length)

    return buffer
  }

  reset () {
    this._reset()
    if (this._coverageBytes) {
      this._coverageBytes.length = 0
    }
  }

  makePayload () {
    this.form.append(
      'event',
      // The intake requires a populated dictionary here. Simply having {} is not valid.
      // We use dummy: true but any other key/value pair would be valid.
      JSON.stringify({ dummy: true }),
      { filename: 'event.json', contentType: 'application/json' }
    )

    const form = this.form

    this.form = new FormData()
    this.fileIndex = 1

    return form
  }
}

module.exports = { CoverageCIVisibilityEncoder }

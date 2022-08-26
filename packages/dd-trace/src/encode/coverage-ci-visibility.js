'use strict'
const { AgentEncoder } = require('./0.4')
const Chunk = require('./chunk')

const FormData = require('../exporters/common/form-data')

const COVERAGE_PAYLOAD_VERSION = 1
const COVERAGE_KEYS_LENGTH = 4
const MAXIMUM_NUM_COVERAGE_FILES = 100

class CoverageCIVisibilityEncoder extends AgentEncoder {
  constructor () {
    super(...arguments)
    this.codeCoverageBuffers = []
    this._coverageBytes = new Chunk()
    this.reset()
  }

  count () {
    return this.codeCoverageBuffers.length
  }

  encode (coverage) {
    const bytes = this._coverageBytes
    const coverageBuffer = this.encodeCodeCoverage(bytes, coverage)
    this.codeCoverageBuffers.push(coverageBuffer)
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
    const form = new FormData()

    let coverageFileIndex = 1

    for (const coverageBuffer of this.codeCoverageBuffers.slice(0, MAXIMUM_NUM_COVERAGE_FILES)) {
      const coverageFilename = `coverage${coverageFileIndex++}`
      form.append(
        coverageFilename,
        coverageBuffer,
        {
          filename: `${coverageFilename}.msgpack`,
          contentType: 'application/msgpack'
        }
      )
    }
    // 'event' is a backend requirement
    form.append('event', JSON.stringify({}), { filename: 'event.json', contentType: 'application/json' })
    this.codeCoverageBuffers = this.codeCoverageBuffers.slice(MAXIMUM_NUM_COVERAGE_FILES)

    return form
  }
}

module.exports = { CoverageCIVisibilityEncoder }

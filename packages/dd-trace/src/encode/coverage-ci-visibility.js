'use strict'
const { AgentEncoder } = require('./0.4')
const Chunk = require('./chunk')

const FormData = require('../exporters/common/form-data')

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

  append ({ span, coverage }) {
    const bytes = this._coverageBytes
    const coveragePayload = {
      version: 1,
      trace_id: span.context()._traceId,
      span_id: span.context()._spanId,
      files: coverage
    }
    const coverageBuffer = this.encodeCodeCoverage(bytes, coveragePayload)
    this.codeCoverageBuffers.push(coverageBuffer)
    this.reset()
  }

  encodeCodeCoverage (bytes, coverage) {
    const keysLength = Object.keys(coverage).length
    this._encodeMapPrefix(bytes, keysLength)
    this._encodeString(bytes, 'version')
    this._encodeInteger(bytes, coverage.version)
    this._encodeString(bytes, 'trace_id')
    this._encodeId(bytes, coverage.trace_id)
    this._encodeString(bytes, 'span_id')
    this._encodeId(bytes, coverage.span_id)
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
    for (const coverageBuffer of this.codeCoverageBuffers) {
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
    // 'event' is needed in the payload
    form.append('event', '', { filename: 'event', contentType: 'application/json' })
    return form
  }
}

module.exports = { CoverageCIVisibilityEncoder }

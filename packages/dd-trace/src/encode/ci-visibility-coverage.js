'use strict'
const { AgentlessCiVisibilityEncoder } = require('./agentless-ci-visibility')
const Chunk = require('./chunk')

const FormData = require('../profiling/exporters/form-data')

class CIVisibilityCoverageEncoder extends AgentlessCiVisibilityEncoder {
  constructor () {
    super(...arguments)
    this.testCodeCoverages = []
    this._coverageBytes = new Chunk()
    this.reset()
  }

  count () {
    return this.testCodeCoverages.length
  }

  append ({ span, coverage }) {
    this.testCodeCoverages.push({
      version: 1,
      trace_id: span.context()._traceId,
      span_id: span.context()._spanId,
      files: coverage
    })
  }

  encodeCodeCoverage (bytes, coverage) {
    const keysLength = Object.keys(coverage).length
    this._encodeMapPrefix(bytes, keysLength)
    this._encodeString(bytes, 'version')
    this._encodeNumber(bytes, coverage.version)
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
    this._coverageBytes.length = 0
    this.testCodeCoverages = []
  }

  makePayload () {
    const form = new FormData()
    const bytes = this._coverageBytes

    let coverageFileIndex = 1
    for (const coverage of this.testCodeCoverages) {
      const coverageFilename = `coverage${coverageFileIndex++}`
      const buffer = this.encodeCodeCoverage(bytes, coverage)
      form.append(
        coverageFilename,
        buffer,
        {
          filename: `${coverageFilename}.msgpack`,
          contentType: 'application/msgpack'
        }
      )
      this.reset()
    }
    // 'event' is needed in the payload
    form.append('event', '', { filename: 'event', contentType: 'application/json' })
    return form
  }
}

module.exports = { CIVisibilityCoverageEncoder }

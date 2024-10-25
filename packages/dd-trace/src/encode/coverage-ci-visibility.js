'use strict'
const { AgentEncoder } = require('./0.4')
const Chunk = require('./chunk')

const {
  distributionMetric,
  TELEMETRY_ENDPOINT_PAYLOAD_SERIALIZATION_MS,
  TELEMETRY_ENDPOINT_PAYLOAD_EVENTS_COUNT
} = require('../ci-visibility/telemetry')
const FormData = require('../exporters/common/form-data')

const COVERAGE_PAYLOAD_VERSION = 2
const COVERAGE_KEYS_LENGTH = 2

class CoverageCIVisibilityEncoder extends AgentEncoder {
  constructor () {
    super(...arguments)
    this._coverageBytes = new Chunk()
    this.form = new FormData()
    this._coveragesCount = 0
    this.reset()
  }

  count () {
    return this._coveragesCount
  }

  encode (coverage) {
    const startTime = Date.now()

    this._coveragesCount++
    this.encodeCodeCoverage(this._coverageBytes, coverage)

    distributionMetric(
      TELEMETRY_ENDPOINT_PAYLOAD_SERIALIZATION_MS,
      { endpoint: 'code_coverage' },
      Date.now() - startTime
    )
  }

  encodeCodeCoverage (bytes, coverage) {
    if (coverage.testId) {
      this._encodeMapPrefix(bytes, 4)
    } else {
      this._encodeMapPrefix(bytes, 3)
    }
    this._encodeString(bytes, 'test_session_id')
    this._encodeId(bytes, coverage.sessionId)
    this._encodeString(bytes, 'test_suite_id')
    this._encodeId(bytes, coverage.suiteId)
    if (coverage.testId) {
      this._encodeString(bytes, 'span_id')
      this._encodeId(bytes, coverage.testId)
    }
    this._encodeString(bytes, 'files')
    this._encodeArrayPrefix(bytes, coverage.files)
    for (const filename of coverage.files) {
      this._encodeMapPrefix(bytes, 1)
      this._encodeString(bytes, 'filename')
      this._encodeString(bytes, filename)
    }
  }

  reset () {
    this._reset()
    if (this._coverageBytes) {
      this._coverageBytes.length = 0
    }
    this._coveragesCount = 0
    this._encodePayloadStart(this._coverageBytes)
  }

  _encodePayloadStart (bytes) {
    const payload = {
      version: COVERAGE_PAYLOAD_VERSION,
      coverages: []
    }
    this._encodeMapPrefix(bytes, COVERAGE_KEYS_LENGTH)
    this._encodeString(bytes, 'version')
    this._encodeInteger(bytes, payload.version)
    this._encodeString(bytes, 'coverages')
    // Get offset of the coverages list to update the length of the array when calling `makePayload`
    this._coveragesOffset = bytes.length
    bytes.reserve(5)
    bytes.length += 5
  }

  makePayload () {
    distributionMetric(TELEMETRY_ENDPOINT_PAYLOAD_EVENTS_COUNT, { endpoint: 'code_coverage' }, this._coveragesCount)
    const bytes = this._coverageBytes

    const coveragesOffset = this._coveragesOffset
    const coveragesCount = this._coveragesCount

    // update with number of coverages
    bytes.buffer[coveragesOffset] = 0xdd
    bytes.buffer[coveragesOffset + 1] = coveragesCount >> 24
    bytes.buffer[coveragesOffset + 2] = coveragesCount >> 16
    bytes.buffer[coveragesOffset + 3] = coveragesCount >> 8
    bytes.buffer[coveragesOffset + 4] = coveragesCount

    const traceSize = bytes.length
    const buffer = Buffer.allocUnsafe(traceSize)

    bytes.buffer.copy(buffer, 0, 0, bytes.length)

    this.form.append(
      'coverage1',
      buffer,
      {
        filename: 'coverage1.msgpack',
        contentType: 'application/msgpack'
      }
    )
    this.form.append(
      'event',
      // The intake requires a populated dictionary here. Simply having {} is not valid.
      // We use dummy: true but any other key/value pair would be valid.
      JSON.stringify({ dummy: true }),
      { filename: 'event.json', contentType: 'application/json' }
    )

    const form = this.form

    this.form = new FormData()
    this.reset()

    return form
  }
}

module.exports = { CoverageCIVisibilityEncoder }

'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')
const id = require('../../src/id')
const { MAX_SIZE, OverflowError } = require('../../src/msgpack')

/**
 * @typedef {{
 *   version: number,
 *   coverages: {
 *     test_session_id: number,
 *     test_suite_id?: number,
 *     span_id?: number,
 *     shared?: string,
 *     parser?: string,
 *     files: { filename: string, bitmap?: Uint8Array }[]
 *   }[] }
 * } CoverageObject
 */

describe('coverage-ci-visibility', () => {
  let encoder
  let logger
  let writer
  let formattedCoverage, formattedCoverage2, formattedCoverageTest

  beforeEach(() => {
    logger = {
      debug: sinon.stub(),
    }
    const { CoverageCIVisibilityEncoder } = proxyquire('../../src/encode/coverage-ci-visibility', {
      '../log': logger,
    })
    writer = { flush: sinon.spy() }
    encoder = new CoverageCIVisibilityEncoder(writer)

    formattedCoverage = {
      sessionId: id('1'),
      suiteId: id('2'),
      files: [{
        filename: 'file.js',
        bitmap: Buffer.from([0, 0, 0, 0x40, 0x01, 0x60]),
      }],
    }
    formattedCoverage2 = {
      sessionId: id('3'),
      suiteId: id('4'),
      files: ['file2.js'],
    }
    formattedCoverageTest = {
      sessionId: id('5'),
      suiteId: id('6'),
      testId: id('7'),
      files: ['file3.js'],
    }
  })

  it('should encode a form', () => {
    encoder.encode(formattedCoverage)
    encoder.encode(formattedCoverage2)

    const form = encoder.makePayload()

    assert.match(form._data[0], /^--/)
    assertObjectContains(
      form._data,
      [
        'Content-Disposition: form-data; name="coverage1"; filename="coverage1.msgpack"\r\n',
        // TODO: The double line breaks seem to be a mistake
        'Content-Type: application/msgpack\r\n\r\n',
      ]
    )
    const decodedCoverages = /** @type {CoverageObject} */ (msgpack.decode(form._data[3]))

    assert.strictEqual(decodedCoverages.version, 2)
    assert.strictEqual(decodedCoverages.coverages.length, 2)
    assertObjectContains(decodedCoverages.coverages[0], { test_session_id: 1, test_suite_id: 2 })
    assert.strictEqual(decodedCoverages.coverages[0].files[0].filename, 'file.js')
    assert.strictEqual(Buffer.from(decodedCoverages.coverages[0].files[0].bitmap).toString('base64'), 'AAAAQAFg')

    assertObjectContains(decodedCoverages.coverages[1], { test_session_id: 3, test_suite_id: 4 })
    assert.deepStrictEqual(decodedCoverages.coverages[1].files[0], { filename: 'file2.js' })
  })

  it('should report its count', () => {
    assert.strictEqual(encoder.count(), 0)

    encoder.encode(formattedCoverage)

    assert.strictEqual(encoder.count(), 1)

    encoder.encode(formattedCoverage)

    assert.strictEqual(encoder.count(), 2)
  })

  it('should reset after making a payload', () => {
    encoder.encode(formattedCoverage)
    encoder.makePayload()

    assert.strictEqual(encoder.count(), 0)
  })

  it('should flush once the queued payload is larger than 1 MiB', () => {
    const encodeBitmapOf = (size) => encoder.encode({
      sessionId: id('1'),
      suiteId: id('2'),
      files: [{ filename: 'file.js', bitmap: Buffer.alloc(size) }],
    })
    encodeBitmapOf(100_000)
    const bytesBesideBitmap = encoder.makePayload()._data[3].length - 100_000

    encodeBitmapOf(1024 * 1024 - bytesBesideBitmap)
    sinon.assert.notCalled(writer.flush)

    encoder.makePayload()
    encodeBitmapOf(1024 * 1024 - bytesBesideBitmap + 1)
    sinon.assert.calledOnce(writer.flush)
  })

  it('drops the queued payload and logs when the chunk cap fires mid-encode', () => {
    logger.error = sinon.stub()
    // Coverage uses its own `_coverageBytes` chunk rather than the parent's
    // `_traceBytes`, so the cap throw skipped the `AgentEncoder.encode`
    // catch path entirely and escaped to the host process. The regression
    // pins that the local catch in `CoverageCIVisibilityEncoder.encode`
    // drops the queued payload instead of throwing.
    encoder.encode(formattedCoverage)
    assert.strictEqual(encoder.count(), 1)

    const originalReserve = encoder._coverageBytes.reserve.bind(encoder._coverageBytes)
    let triggered = false
    sinon.stub(encoder._coverageBytes, 'reserve').callsFake(function (size) {
      if (triggered) return originalReserve(size)
      triggered = true
      throw new OverflowError(MAX_SIZE + 1)
    })

    encoder.encode(formattedCoverage2)

    assert.strictEqual(encoder.count(), 0, 'queued payload must be dropped on overflow')
    sinon.assert.calledOnce(logger.error)
  })

  it('rethrows non-overflow encode errors', () => {
    sinon.stub(encoder._coverageBytes, 'reserve').throws(new Error('not an overflow'))

    assert.throws(() => encoder.encode(formattedCoverage), /not an overflow/)
  })

  it('should be able to make multiple payloads', () => {
    let form, decodedCoverages
    encoder.encode(formattedCoverage)
    form = encoder.makePayload()
    decodedCoverages = /** @type {CoverageObject} */ (msgpack.decode(form._data[3]))
    assert.strictEqual(decodedCoverages.version, 2)
    assert.strictEqual(decodedCoverages.coverages.length, 1)
    assertObjectContains(decodedCoverages.coverages[0], { test_session_id: 1, test_suite_id: 2 })

    encoder.encode(formattedCoverage2)
    form = encoder.makePayload()
    decodedCoverages = /** @type {CoverageObject} */ (msgpack.decode(form._data[3]))
    assert.strictEqual(decodedCoverages.version, 2)
    assert.strictEqual(decodedCoverages.coverages.length, 1)
    assertObjectContains(decodedCoverages.coverages[0], { test_session_id: 3, test_suite_id: 4 })
  })

  it('should be able to encode test coverages', () => {
    encoder.encode(formattedCoverageTest)

    const form = encoder.makePayload()

    assert.match(form._data[0], /^--/)
    assertObjectContains(
      form._data,
      [
        'Content-Disposition: form-data; name="coverage1"; filename="coverage1.msgpack"\r\n',
        'Content-Type: application/msgpack\r\n\r\n',
      ]
    )

    const decodedCoverages = /** @type {CoverageObject} */ (msgpack.decode(form._data[3]))

    assert.strictEqual(decodedCoverages.version, 2)
    assert.strictEqual(decodedCoverages.coverages.length, 1)
    assertObjectContains(decodedCoverages.coverages[0], { test_session_id: 5, test_suite_id: 6, span_id: 7 })
    assert.deepStrictEqual(decodedCoverages.coverages[0].files[0], { filename: 'file3.js' })
  })

  it('should be able to encode session executable line coverage', () => {
    encoder.encode({
      sessionId: id('8'),
      files: [{
        filename: 'file4.js',
        bitmap: Buffer.from([0x80]),
      }],
    })

    const form = encoder.makePayload()
    const decodedCoverages = /** @type {CoverageObject} */ (msgpack.decode(form._data[3]))

    assert.strictEqual(decodedCoverages.coverages.length, 1)
    assertObjectContains(decodedCoverages.coverages[0], { test_session_id: 8 })
    assert.ok(!('test_suite_id' in decodedCoverages.coverages[0]))
    assert.strictEqual(decodedCoverages.coverages[0].files[0].filename, 'file4.js')
    assert.strictEqual(Buffer.from(decodedCoverages.coverages[0].files[0].bitmap).toString('base64'), 'gA==')
  })

  it('should encode the parser a line coverage record names, and no parser key without one', () => {
    encoder.encode({ ...formattedCoverageTest, parser: 'oxc-binding' })
    encoder.encode({ sessionId: id('8'), shared: 'init', parser: 'none', files: ['file4.js'] })
    encoder.encode(formattedCoverage2)

    const form = encoder.makePayload()
    const { coverages } = /** @type {CoverageObject} */ (msgpack.decode(form._data[3]))

    assert.deepStrictEqual(coverages[0], {
      test_session_id: 5,
      test_suite_id: 6,
      span_id: 7,
      parser: 'oxc-binding',
      files: [{ filename: 'file3.js' }],
    })
    assert.deepStrictEqual(coverages[1], {
      test_session_id: 8,
      shared: 'init',
      parser: 'none',
      files: [{ filename: 'file4.js' }],
    })
    assert.ok(!('parser' in coverages[2]))
  })

  it('should encode a bitmap a test worker sent as base64 as its bytes', () => {
    encoder.encode({
      sessionId: id('9'),
      suiteId: id('10'),
      testId: id('11'),
      files: [{ filename: 'file5.js', bitmap: 'AAAAQAFg' }],
    })

    const form = encoder.makePayload()
    const decodedCoverages = /** @type {CoverageObject} */ (msgpack.decode(form._data[3]))

    assert.strictEqual(decodedCoverages.coverages[0].files[0].filename, 'file5.js')
    assert.deepStrictEqual(
      Buffer.from(decodedCoverages.coverages[0].files[0].bitmap),
      Buffer.from([0, 0, 0, 0x40, 0x01, 0x60])
    )
  })
})

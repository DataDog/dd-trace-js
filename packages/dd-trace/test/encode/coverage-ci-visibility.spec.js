'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')
const id = require('../../src/id')

/**
 * @typedef {{
 *   version: number,
 *   coverages: { test_session_id: number, test_suite_id: number, files: { filename: string }[] }[] }
 * } CoverageObject
 */

describe('coverage-ci-visibility', () => {
  let encoder
  let logger
  let formattedCoverage, formattedCoverage2, formattedCoverageTest

  beforeEach(() => {
    logger = {
      debug: sinon.stub(),
    }
    const { CoverageCIVisibilityEncoder } = proxyquire('../../src/encode/coverage-ci-visibility', {
      '../log': logger,
    })
    encoder = new CoverageCIVisibilityEncoder()

    formattedCoverage = {
      sessionId: id('1'),
      suiteId: id('2'),
      files: ['file.js'],
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

    assert.ok(form._data[0].startsWith('--'))
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
    assert.deepStrictEqual(decodedCoverages.coverages[0].files[0], { filename: 'file.js' })

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

    assert.ok(form._data[0].startsWith('--'))
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
})

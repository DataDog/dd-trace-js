'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')
const msgpack = require('@msgpack/msgpack')

const id = require('../../src/id')

t.test('coverage-ci-visibility', t => {
  let encoder
  let logger
  let formattedCoverage, formattedCoverage2, formattedCoverageTest

  t.beforeEach(() => {
    logger = {
      debug: sinon.stub()
    }
    const { CoverageCIVisibilityEncoder } = proxyquire('../src/encode/coverage-ci-visibility', {
      '../log': logger
    })
    encoder = new CoverageCIVisibilityEncoder()

    formattedCoverage = {
      sessionId: id('1'),
      suiteId: id('2'),
      files: ['file.js']
    }
    formattedCoverage2 = {
      sessionId: id('3'),
      suiteId: id('4'),
      files: ['file2.js']
    }
    formattedCoverageTest = {
      sessionId: id('5'),
      suiteId: id('6'),
      testId: id('7'),
      files: ['file3.js']
    }
  })

  t.test('should encode a form', t => {
    encoder.encode(formattedCoverage)
    encoder.encode(formattedCoverage2)

    const form = encoder.makePayload()

    expect(form._data[1]).to.contain('Content-Disposition: form-data; name="coverage1"; filename="coverage1.msgpack"')
    expect(form._data[2]).to.contain('Content-Type: application/msgpack')

    const decodedCoverages = msgpack.decode(form._data[3])

    expect(decodedCoverages.version).to.equal(2)
    expect(decodedCoverages.coverages).to.have.length(2)
    expect(decodedCoverages.coverages[0]).to.contain({ test_session_id: 1, test_suite_id: 2 })
    expect(decodedCoverages.coverages[0].files[0]).to.eql({ filename: 'file.js' })

    expect(decodedCoverages.coverages[1]).to.contain({ test_session_id: 3, test_suite_id: 4 })
    expect(decodedCoverages.coverages[1].files[0]).to.eql({ filename: 'file2.js' })
    t.end()
  })

  t.test('should report its count', t => {
    expect(encoder.count()).to.equal(0)

    encoder.encode(formattedCoverage)

    expect(encoder.count()).to.equal(1)

    encoder.encode(formattedCoverage)

    expect(encoder.count()).to.equal(2)
    t.end()
  })

  t.test('should reset after making a payload', t => {
    encoder.encode(formattedCoverage)
    encoder.makePayload()

    expect(encoder.count()).to.equal(0)
    t.end()
  })

  t.test('should be able to make multiple payloads', t => {
    let form, decodedCoverages
    encoder.encode(formattedCoverage)
    form = encoder.makePayload()
    decodedCoverages = msgpack.decode(form._data[3])
    expect(decodedCoverages.version).to.equal(2)
    expect(decodedCoverages.coverages).to.have.length(1)
    expect(decodedCoverages.coverages[0]).to.contain({ test_session_id: 1, test_suite_id: 2 })

    encoder.encode(formattedCoverage2)
    form = encoder.makePayload()
    decodedCoverages = msgpack.decode(form._data[3])
    expect(decodedCoverages.version).to.equal(2)
    expect(decodedCoverages.coverages).to.have.length(1)
    expect(decodedCoverages.coverages[0]).to.contain({ test_session_id: 3, test_suite_id: 4 })
    t.end()
  })

  t.test('should be able to encode test coverages', t => {
    encoder.encode(formattedCoverageTest)

    const form = encoder.makePayload()

    expect(form._data[1]).to.contain('Content-Disposition: form-data; name="coverage1"; filename="coverage1.msgpack"')
    expect(form._data[2]).to.contain('Content-Type: application/msgpack')

    const decodedCoverages = msgpack.decode(form._data[3])

    expect(decodedCoverages.version).to.equal(2)
    expect(decodedCoverages.coverages).to.have.length(1)
    expect(decodedCoverages.coverages[0]).to.contain({ test_session_id: 5, test_suite_id: 6, span_id: 7 })
    expect(decodedCoverages.coverages[0].files[0]).to.eql({ filename: 'file3.js' })
    t.end()
  })
  t.end()
})

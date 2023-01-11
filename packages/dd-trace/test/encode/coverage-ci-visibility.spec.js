'use strict'

const { expect } = require('chai')
const msgpack = require('msgpack-lite')

const id = require('../../src/id')

describe('coverage-ci-visibility', () => {
  let encoder
  let logger
  let formattedCoverage, formattedCoverage2

  beforeEach(() => {
    logger = {
      debug: sinon.stub()
    }
    const { CoverageCIVisibilityEncoder } = proxyquire('../src/encode/coverage-ci-visibility', {
      '../log': logger
    })
    encoder = new CoverageCIVisibilityEncoder()

    formattedCoverage = {
      traceId: id('1'),
      spanId: id('2'),
      files: ['file.js']
    }
    formattedCoverage2 = {
      traceId: id('3'),
      spanId: id('4'),
      files: ['file2.js']
    }
  })

  it('should encode a form', () => {
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
  })

  it('should report its count', () => {
    expect(encoder.count()).to.equal(0)

    encoder.encode(formattedCoverage)

    expect(encoder.count()).to.equal(1)

    encoder.encode(formattedCoverage)

    expect(encoder.count()).to.equal(2)
  })

  it('should reset after making a payload', () => {
    encoder.encode(formattedCoverage)
    encoder.makePayload()

    expect(encoder.count()).to.equal(0)
  })

  it('should be able to make multiple payloads', () => {
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
  })
})

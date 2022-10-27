'use strict'

const { expect } = require('chai')
const msgpack = require('msgpack-lite')

const id = require('../../src/id')

describe('coverage-ci-visibility', () => {
  let encoder
  let logger
  let formattedCoverage

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
  })

  it('should encode a form', () => {
    encoder.encode(formattedCoverage)

    const form = encoder.makePayload()

    expect(form._data[1]).to.contain('Content-Disposition: form-data; name="coverage1"; filename="coverage1.msgpack"')
    expect(form._data[2]).to.contain('Content-Type: application/msgpack')

    const decodedCoverage = msgpack.decode(form._data[3])

    expect(decodedCoverage).to.contain({
      version: 1,
      trace_id: 1,
      span_id: 2
    })
    expect(decodedCoverage.files).to.have.length(1)
    expect(decodedCoverage.files[0].filename).to.equal('file.js')
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
})

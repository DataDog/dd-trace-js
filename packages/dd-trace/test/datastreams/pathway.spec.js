'use strict'

require('../setup/tap')

const { expect } = require('chai')
const { computePathwayHash, encodePathwayContext, decodePathwayContext } = require('../../src/datastreams/pathway')

describe('encoding', () => {
  it('hash should always give the same value', () => {
    // note: we use a different hash function than the one used in the other languages,
    // so if you switch language, the hash will change.
    // given the tag resolution we do on the backend, this is not a big issue.
    const hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))
    expect(hash)
      .to.deep.equal(Buffer.from('ec99e1e8e682985d', 'hex'))
  })
  it('encoding and decoding should be a no op', () => {
    const expectedContext = {
      hash: Buffer.from('4cce4d8e07685728', 'hex'),
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    const encoded = encodePathwayContext(expectedContext)
    const decoded = decodePathwayContext(encoded)
    expect(decoded.hash.toString()).to.equal(expectedContext.hash.toString())
    expect(decoded.pathwayStartNs).to.equal(expectedContext.pathwayStartNs)
    expect(decoded.edgeStartNs).to.equal(expectedContext.edgeStartNs)
  })
  it('decoding of a context should be consistent between languages', () => {
    const data = Buffer.from([76, 206, 77, 142, 7, 104, 87, 40, 196, 231,
      192, 159, 143, 98, 200, 217, 195, 159, 143, 98])
    const decoded = decodePathwayContext(data)
    const expectedContext = {
      hash: Buffer.from('4cce4d8e07685728', 'hex'),
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    expect(decoded.hash.toString()).to.equal(expectedContext.hash.toString())
    expect(decoded.pathwayStartNs).to.equal(expectedContext.pathwayStartNs)
    expect(decoded.edgeStartNs).to.equal(expectedContext.edgeStartNs)
  })
})

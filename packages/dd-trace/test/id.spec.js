'use strict'

const unsignedHexExpr = /^[0-7][0-9a-f]{15}$/

describe.only('id', () => {
  let id

  beforeEach(() => {
    id = require('../src/id')
  })

  it('should return a random ID limited to unsigned integers', () => {
    const ids = new Set()

    // loop to ensure ID never has the sign bit set and doesn't collide
    for (let i = 0; i < 1000; i++) {
      const testId = id()

      expect(testId.toString(16).padStart(16, '0')).to.match(unsignedHexExpr)
      expect(ids.has(testId.toString())).to.be.false

      ids.add(testId.toString())
    }
  })

  it('should support hex strings', () => {
    const spanId = id('abcd', 16)

    expect(spanId.toString(16)).to.equal('abcd')
  })

  it('should support number strings', () => {
    const spanId = id('1234', 10)

    expect(spanId.toString(10)).to.equal('1234')
  })

  it('should be serializable to various formats', () => {
    const testId = id('7f00ff00ff00ff00', 16)
    const numToHex = num => num.toString(16).padStart(2, 0)

    expect(JSON.stringify(testId)).to.equal('"9151594822560186112"')
    expect(testId.toString()).to.equal('9151594822560186112')
    expect(testId.toString(10)).to.equal('9151594822560186112')
    expect(testId.toString(16)).to.equal('7f00ff00ff00ff00')
    expect(testId.toArray().map(numToHex).join('')).to.equal('7f00ff00ff00ff00')
  })
})

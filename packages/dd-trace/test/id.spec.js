'use strict'

describe('id', () => {
  let id
  let crypto

  beforeEach(() => {
    crypto = {
      randomFillSync: data => {
        for (let i = 0; i < data.length; i += 8) {
          data[i] = 0xFF
          data[i + 1] = 0x00
          data[i + 2] = 0xFF
          data[i + 3] = 0x00
          data[i + 4] = 0xFF
          data[i + 5] = 0x00
          data[i + 6] = 0xFF
          data[i + 7] = 0x00
        }
      }
    }

    sinon.stub(Math, 'random')

    id = proxyquire('../src/id', {
      'crypto': crypto
    })
  })

  afterEach(() => {
    Math.random.restore()
  })

  it('should return a random 63bit ID', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    expect(id().toString()).to.equal('7f00ff00ff00ff00')
  })

  it('should be serializable to an integer', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const spanId = id()

    expect(spanId.toString(10)).to.equal('9151594822560186112')
  })

  it('should be serializable to JSON', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const json = JSON.stringify(id())

    expect(json).to.equal('"7f00ff00ff00ff00"')
  })

  it('should support small hex strings', () => {
    const spanId = id('abcd', 16)

    expect(spanId.toString()).to.equal('abcd')
  })

  it('should support large hex strings', () => {
    const spanId = id('12293a8527e70a7f27c8d624ace0f559', 16)

    expect(spanId.toString()).to.equal('12293a8527e70a7f27c8d624ace0f559')
    expect(spanId.toString(10)).to.equal('2866776615828911449')
  })

  it('should use hex strings by default', () => {
    const spanId = id('abcd')

    expect(spanId.toString()).to.equal('abcd')
  })

  it('should support number strings', () => {
    const spanId = id('1234', 10)

    expect(spanId.toString(10)).to.equal('1234')
  })
})
